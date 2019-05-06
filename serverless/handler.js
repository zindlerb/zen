const AWS = require('aws-sdk')

module.exports.workTests = async (opts, context, callback) => {
  const ChromeWrapper = require('./lib/chrome')
  let wrapper, manifest, remaining = opts.testNames.slice(), results = []
  delete opts.testNames

  try {
    console.log('Starting')
    wrapper = new ChromeWrapper({})

    await Promise.all([
      wrapper.launchLambda(),
      getManifest(opts.Bucket, opts.sessionId).then(m => manifest = m)
    ])

    console.log('Opening tab')
    let tab = await wrapper.openTab(opts.url)
    tab.manifest = manifest

    if (opts.sessionId && !manifest) { // temp to handle old clients
      throw new Error(`Missing manifest for ${opts.sessionId}`)
    }

    console.log('Starting tests')
    while (remaining.length > 0) {
      let testOpts = Object.assign({}, opts, {testName: remaining.shift()})
      let r = await tab.setTest(testOpts)
      r.logStream = context.logStreamName
      results.push(r)
    }

    callback(null, {statusCode: 200, body: results})

  } catch (e) {
    console.error(e)
    e.logStream = context.logStreamName
    callback(e)

  } finally {
    if (wrapper) wrapper.kill()
  }
}

module.exports.sync = async (manifest) => {
  let s3 = new AWS.S3({params: {Bucket: manifest.bucket}})

  // Write the updated session manifest to S3
  let manifestWrite = s3.putObject({
    Key: `session-${manifest.sessionId}.json`,
    Body: JSON.stringify(manifest)
  }).promise()

  // List out all the files we already have in S3
  let cached = [], listOpts = {}
  while (listOpts) {
    console.log('Listing objects', listOpts)
    let resp = await s3.listObjectsV2(listOpts).promise()
    console.log('Got resp', resp)
    cached.push.apply(cached, resp.Contents.map(c => c.Key))
    listOpts.ContinuationToken = resp.NextContinuationToken
    if (!resp.IsTruncated) listOpts = null
  }
  console.log(`Found ${cached.length} items in S3`)

  // Figure out which ones are specified in the manifest that we don't have
  let files = Object.keys(manifest.files).map(p => {
    let key = manifest.files[p]
    return {path: p, key, needed: cached.indexOf(key) === -1}
  })
  let needed = files.filter(f => f.needed)
  console.log(`Need ${needed.length} files to run tests`)

  await manifestWrite
  console.log('Manifest written')
  return {needed}
}

module.exports.routeRequest = async (event) => {
  let [Bucket, sessionId, ...rest] = event.path.split('/').slice(1)
  let manifest = await getManifest(Bucket, sessionId)
  let path = decodeURIComponent(rest.join('/'))
  console.log('Routing', Bucket, sessionId, path)

  if (!manifest) {
    return {statusCode: 404, headers: {}, body: 'manifest not found'}
  }

  if (path === 'index.html') {
    return {statusCode: 200, headers: {"content-type": "text/html"}, body: manifest.index}
  }

  let key = manifest.files[path]
  if (!key) {
    return {statusCode: 404, headers: {}, body: 'path not found in manifest'}
  }

  return {statusCode: 301, headers: {Location: `https://s3-us-west-2.amazonaws.com/${Bucket}/${encodeURIComponent(key)}`}}
}

async function getManifest (Bucket, sessionId) {
  if (!sessionId) return // temp to support old clients
  try {
    let s3 = new AWS.S3()
    let resp = await s3.getObject({Bucket, Key: `session-${sessionId}.json`}).promise()
    return JSON.parse(resp.Body.toString('utf-8'))
  } catch (e) {
    console.log(e)
    return null
  }
}
