// Run: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../parse.js');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('place URL prefers the exact pin over the viewport center', () => {
  const [s] = P.parseUrl('https://www.google.com/maps/place/Eiffel+Tower/@48.8583701,2.2919064,17z/data=!3m1!4b1!4m6!3m5!1s0x47e66e2964e34e2d:0x8ddca9ee380ef7e0!8m2!3d48.8583701!4d2.2944813!16zL20vMDJqODE');
  assert.equal(s.name, 'Eiffel Tower');
  near(s.lat, 48.8583701); near(s.lng, 2.2944813);
  assert.equal(s.camera.zoom, 17);
});

test('Earth-style URL keeps heading, tilt and distance', () => {
  const [s] = P.parseUrl('https://www.google.com/maps/@40.6892,-74.0445,50a,800d,35y,120h,65t/data=!3m1!1e3');
  near(s.lat, 40.6892); near(s.lng, -74.0445);
  assert.deepEqual(s.camera, { range: 800, heading: 120, tilt: 65 });
});

test('street view URL becomes a close, tilted camera', () => {
  const [s] = P.parseUrl('https://www.google.com/maps/@51.5007,-0.1246,3a,75y,90h,95t/data=!3m6');
  assert.equal(s.camera.heading, 90);
  assert.equal(s.camera.tilt, 72);
});

test('query parameters: q coords, q name, api=1 query, ll', () => {
  let [s] = P.parseUrl('https://maps.google.com/?q=35.6586,139.7454');
  near(s.lat, 35.6586);
  [s] = P.parseUrl('https://www.google.com/maps?q=Sydney+Opera+House');
  assert.equal(s.query, 'Sydney Opera House');
  assert.equal(s.lat, undefined);
  [s] = P.parseUrl('https://www.google.com/maps/search/?api=1&query=47.5951518%2C-122.3316393');
  near(s.lng, -122.3316393);
  [s] = P.parseUrl('https://maps.google.com/maps?ll=37.8199,-122.4783&z=15');
  near(s.lat, 37.8199); assert.equal(s.camera.zoom, 15);
});

test('dropped pin with DMS in the path', () => {
  const [s] = P.parseUrl("https://www.google.com/maps/place/48%C2%B051'30.0%22N+2%C2%B017'40.0%22E/@48.8583333,2.2944444,17z");
  near(s.lat, 48.858333, 1e-5); near(s.lng, 2.294444, 1e-5);
});

test('directions URL yields every stop', () => {
  const specs = P.parseUrl('https://www.google.com/maps/dir/Colosseum,+Rome/41.9022,12.4539/Pantheon/@41.89,12.48,14z/data=!4m2');
  assert.equal(specs.length, 3);
  assert.equal(specs[0].name, 'Colosseum');
  near(specs[1].lat, 41.9022);
  assert.equal(specs[2].query, 'Pantheon');
});

test('short links are flagged, not guessed', () => {
  assert.equal(P.parseUrl('https://maps.app.goo.gl/abc123')[0].error, 'short');
});

test('geo: URIs', () => {
  const [s] = P.parseUrl('geo:37.786971,-122.399677?q=Moscone');
  near(s.lat, 37.786971); assert.equal(s.name, 'Moscone');
});

test('free text: urls with labels, coords, names, comments', () => {
  const specs = P.parseText([
    '# my trip',
    'Hotel: https://www.google.com/maps/@48.85,2.29,17z',
    '40.6892, -74.0445',
    '-33.8568 151.2153',
    'Machu Picchu',
  ].join('\n'));
  assert.equal(specs.length, 4);
  assert.equal(specs[0].name, 'Hotel');
  near(specs[1].lng, -74.0445);
  near(specs[2].lat, -33.8568);
  assert.equal(specs[3].query, 'Machu Picchu');
});

test('label followed by coordinates', () => {
  let [s] = P.parseText('Matterhorn 45.9763889,7.6586111');
  assert.equal(s.name, 'Matterhorn'); near(s.lat, 45.9763889);
  [s] = P.parseText('Base camp: -13.1631, -72.5450');
  assert.equal(s.name, 'Base camp'); near(s.lng, -72.545);
  [s] = P.parseText('Route 66');
  assert.equal(s.query, 'Route 66');
});

test('Google Takeout Saved Places GeoJSON', () => {
  const specs = P.parseGeoJSON({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [-122.4194, 37.7749] },
        properties: { location: { name: 'SF', address: 'San Francisco, CA' } } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] },
        properties: { google_maps_url: 'http://maps.google.com/?cid=123', location: { name: 'Louvre', address: 'Paris' } } },
    ],
  });
  near(specs[0].lat, 37.7749); assert.equal(specs[0].name, 'SF');
  assert.equal(specs[1].query, 'Louvre, Paris');
});

test('Takeout saved-list CSV and lat/lng CSV', () => {
  let specs = P.parseCSV('Title,Note,URL,Comment\n"Blue Bottle, Oakland",,https://www.google.com/maps/place/Blue+Bottle/data=!4m2!3m1!1s0x0:0x1,\nPier 39,,"https://www.google.com/maps/place/Pier+39/@37.8087,-122.4098,17z",');
  assert.equal(specs[0].query, 'Blue Bottle, Oakland');
  near(specs[1].lat, 37.8087); assert.equal(specs[1].name, 'Pier 39');
  specs = P.parseCSV('name,latitude,longitude\nA,10.5,20.25');
  near(specs[0].lng, 20.25);
});
