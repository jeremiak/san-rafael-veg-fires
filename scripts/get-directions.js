const fs = require('fs')
const path = require('path')
const util = require('util')

const http = require('axios')
const d3 = require('d3')
const { queue } = require('d3-queue')
const delayMap = require('delay-map')
const polyline = require('@mapbox/polyline')
const simplify = require('simplify-geojson')

const dataPath = file => path.join(__dirname, '../data', file)
const read = util.promisify(fs.readFile)
const readCsv = path => (
  read(path, { encoding: 'utf8' }).then(d => d3.csvParse(d))
)
const write = util.promisify(fs.writeFile)

const files = ['fires.csv', 'stations.csv'].map(dataPath).map(readCsv)
const key = process.env.GOOGLE_MAPS_API_KEY
const routeApi = 'https://maps.googleapis.com/maps/api/directions/json'

const fmtAddr = str => str.replace(/ /g, '+')
const getDirections = (start, end) => {
  console.log(`getting directions from ${start} to ${end}`)
  const params = `origin=${fmtAddr(start)}&destination=${fmtAddr(end)}&key=${key}`
  const url = `${routeApi}?${params}`

  return http.get(url).then(response => {
    if (response.status !== 200) throw new Error(response.status)
    if (response.data.error_message) throw new Error(response.data.error_message)

    let steps
    try {
      steps = response.data.routes[0].legs[0].steps
    } catch (e) {
      console.error(e)
      return
    }

    // combine all the line strings into one
    return steps.map(step => (
      polyline.toGeoJSON(step.polyline.points).coordinates
    )).map((step, i) => {
      const isLast = i === steps.length - 1
      if (isLast) return step
      return step.slice(0, step.length - 1)
    }).reduce((accum, next) => {
      return accum.concat(next)
    }, [])
  }).catch(err => {
    console.error(url, err)
  })
}

const fetchDirections = (fire, cb) => {
  const start = fire.address.replace(/#/g, '')
  const end = `${fire.station.address} San Rafael CA`
  getDirections(start, end).then(steps => {
    const feature = {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: steps
      },
      properties: {
        ...fire
      }
    }
    cb(null, feature)
  })
}

Promise.all(files).then(([fires, stations]) => {
  const directions = fires.map(fire => {
    const matchingStation = stations.find(s =>
      s['Station number'] === fire.StationNumber
    )
    return {
      id: fire.IncidentNumber,
      date: fire.IncidentDate,
      time: fire.IncidentTime,
      address: fire.Address,
      lat: fire.Latitude,
      long: fire.Longitude,
      station: {
        number: fire.StationNumber,
        address: matchingStation ? matchingStation.Address : null
      }
    }
  })

  const q = queue(2)
  const failed = []
  directions.forEach(fire => {
    if (!fire.station.address) {
      failed.push(fire)
      return
    }

    q.defer(fetchDirections, fire)
  })

  q.awaitAll((err, features) => {
    const dest = dataPath('directions.json')
    const fail = dataPath('failed.json')
    const collection = simplify({
      type: 'FeatureCollection',
      features: features.filter(f => f.geometry.coordinates),
    }, 0.001)
    const withoutGeo = features.filter(f => !f.geometry.coordinates).map(f => f.properties)
    Promise.all([
      write(dest, JSON.stringify(collection, null, 2)),
      write(fail, JSON.stringify(failed.concat(withoutGeo), null, 2))
    ]).then(() => {
      const noStation = failed.filter(f => f.station.address === null)
      console.log(`done! wrote directions for ${features.length} fires to ${dest}`)
      console.log(`\there were ${directions.length} in the original data`)
      console.log(`\twrote the ${failed.length} unprocessed fires to ${fail}, ${noStation.length} of them do not have any station address`)
    })
  })
})
