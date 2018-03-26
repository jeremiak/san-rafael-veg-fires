const fs = require('fs')
const path = require('path')
const util = require('util')

const d3 = require('d3')
const http = require('axios')
const polyline = require('@mapbox/polyline')

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

    const steps = response.data.routes[0].legs[0].steps

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
  })
}

Promise.all(files).then(([fires, stations]) => {
  const directions = fires.map(fire => {
    const matchingStation = stations.find(s => (
      s['Station number'] === fire.StationNumber
    ))
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
  }).slice(0, 5).map(fire => {
    const start = fire.address
    const end = `${fire.station.address} San Rafael CA`
    return getDirections(start, end).then(steps => ({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: steps
      },
      properties: {
        ...fire
      }
    }))
  })

  Promise.all(directions).then(d => {
    const dest = dataPath('driving.geojson')
    const collection = {
      type: 'FeatureCollection',
      features: d
    }
    write(dest, JSON.stringify(collection)).then(() => {
      console.log(`done! wrote directions to ${dest}`)
    })
  })
})
