'use strict'

const path = require('path');
const Promise = require('bluebird');
const fs = Promise.promisifyAll(require('fs-extra'));
const fsp = require('fs-promise');

const rp = require('request-promise-native');
const htmlparser = require('htmlparser2');

const {
  TYPES,
  TYPE_UPLOAD,
  UPLOAD_URLS,
  MULTIFORM_PAGE,
  MULTIFORM_UPLOAD,
  UPLOAD_FILENAME
} = require('./constants.js');

const { currentYear, debug } = require('./util.js');
const compare = require('./compare.js');

const getMultiform = ({
  url,
  type,
  dest,
  source,
  jar,
  year,
  teamName
}) => {
  return rp({ url, jar })
    .then((body) => {
      const multiform = type === TYPE_UPLOAD ? MULTIFORM_UPLOAD : MULTIFORM_PAGE;

      const parser = new htmlparser.Parser({
        onopentag: (name, attr) => {
          if (attr.name && Object.keys(multiform).indexOf(attr.name) !== -1) {
            if (attr.value) {
              multiform[attr.name] = attr.value;
            } else {
              multiform[attr.name] = '';
            }
          }
        }
      }, { decodeEntities: true });

      parser.write(body);
      parser.end();

      // Resolves to filled multiform
      return new Promise((resolve, reject) => {
        if (type === TYPE_UPLOAD) {
          // TODO check for bad image name (e.g. has :, /)
          const destFile = UPLOAD_FILENAME({ year, teamName, dest });

          multiform['wpUploadFile'] = fs.createReadStream(source);
          multiform['wpDestFile'] = destFile
          // TODO expose this as an option
          multiform['wpUploadDescription'] = `Uploaded on ${new Date().toString()} using igemwiki-api (https://github.com/igemuoftATG/igemwiki-api)`

          debug(`Gonna upload ${source} to ${destFile}`)

          resolve(multiform);
        } else {
          // page, template, stylesheet, or script
          fs.readFileAsync(source, 'utf-8')
            .then((contents) => {
              multiform['wpTextbox1'] = contents;

              // debug('multiform: ', multiform)
              resolve(multiform);
            })
            .catch(reject);
        }
      });
    });
};

const postMultiform = ({
  url,
  type,
  multiform,
  dest,
  jar,
  year,
  responseDetails
}) => {
  // debug('posting with multiform: ', multiform)

  return rp({
    url,
    method: 'POST',
    formData: multiform,
    jar,
    // see login.js for what these options do
    resolveWithFullResponse: true,
    simple: false
  }).then((res) => {
    // TODO make a generic redirect handler
    if (res.statusCode === 302) {
      debug('Redirecting to: ', res.headers.location);
      return rp({
        url: res.headers.location,
        jar
      });
    } else if (res.statusCode === 200) {
      debug(`Upload failed for ${dest}`);
      // debug(res.body)
      throw new Error('Upload failed');
    }
  }).then((body) => {
    if (type === TYPE_UPLOAD) {
      let currentHref = '';
      let finalHref = '';

      const parser = new htmlparser.Parser({
        onopentag: (name, attr) => {
          if (name === 'a') currentHref = attr.href
        },
        ontext: (text) => {
          switch(text) {
            case 'Full resolution':
              finalHref = currentHref
              break
            case multiform['wpDestFile']:
              finalHref = currentHref
              break
            case 'Original file':
              finalHref = currentHref
              break
            default:
              break
          }
        }
      }, { decodeEntities: true })

      parser.write(body)
      parser.end()

      responseDetails.target = `https://${year}.igem.org${finalHref}`
    } else {
      // responseDetails.target = baseUrl
    }

    responseDetails.status = 'uploaded'
    return responseDetails
  })
//if statement that checks for regex, then console.log ("TimeOut Error")
  //.catch(err => console.error('ERROR:', err))
}

const upload = ({
  type,
  dest,
  source,
  year = currentYear,
  teamName,
  jar,
  force
}) => {
  if (TYPES.indexOf(type) === -1) return Promise.reject('Invalid type')

  const _baseUrl = UPLOAD_URLS({ year, teamName })[type]
  const baseUrl = dest === 'INDEX' || type === TYPE_UPLOAD ? _baseUrl : _baseUrl + '/' + dest
  const editUrl = baseUrl + '?action=edit'
  const postUrl = type === TYPE_UPLOAD ? baseUrl : baseUrl + '?action=submit'
  debug('editUrl: ', editUrl)
  debug('postUrl: ', postUrl)

  const startTime = Date.now()

  const responseDetails = {
    status: '',
    type,
    source: source,
    target: baseUrl,
    start: new Date().toString(),
    end: '',
    time: ''
  }

  const preChecks = [
    fs.statAsync(source)
  ]

  // Add an extra promise to check if local and external are identical,
  // or if force is on, automatically return "not equal" i.e. false
  if (force) {
    preChecks.push(new Promise((resolve, reject) => resolve(false)))
  } else if (type === TYPE_UPLOAD) {
    const fileSearch = require('./file-search.js')({ year, teamName })

    preChecks.push(new Promise((resolve, reject) => {
      fileSearch({ medianame: dest })
        .then((imageUrl) => {
          responseDetails.target = imageUrl

          return compare({ url: imageUrl, fileName: source, isImage: true })
        })
        .then((equal) => {
          resolve(equal)
        })
        .catch((err) => {
          debug('ERROR: ' + err)
          resolve(false)
        })
        // .catch(reject)
    }))
  } else {
    preChecks.push(new Promise((resolve, reject) => {
      compare({ url: editUrl, fileName: source })
        .then(equal => resolve(equal))
        .catch(reject)
    }))
  }

  return Promise.all(preChecks).then((resolvedValues) => {
    const equal = resolvedValues[1]
    if (equal) {
      responseDetails.status = 'skipped'

      return responseDetails
    } else {
      return getMultiform({
        url: editUrl,
        type,
        dest,
        source,
        jar,
        year,
        teamName
      }).then(multiform => postMultiform({
        url: postUrl,
        type,
        multiform,
        dest,
        jar,
        year,
        responseDetails
      }))
    }
  }).then((responseDetails) => {
    if (responseDetails) {
      responseDetails.end = new Date().toString()
      responseDetails.time = Date.now() - startTime
    }

    debug('responseDetails:', JSON.stringify(responseDetails, null, 2))

    console.log(`${responseDetails.status}[${responseDetails.time}ms] ${responseDetails.source} -> ${responseDetails.target}`)
    return(responseDetails)
  })
}

module.exports = ({ year, teamName }) => ({
  type,
  dest,
  source,
  jar,
  force = false
}) => upload({
  year,
  teamName,
  type,
  dest,
  source,
  jar,
  force
})
