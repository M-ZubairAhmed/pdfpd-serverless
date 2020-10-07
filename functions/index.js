const functions = require('firebase-functions')
const path = require('path')
const os = require('os')
const fs = require('fs')
const Busboy = require('busboy')
const sanitize = require('sanitize-filename')
const pdfjs = require('pdfjs-dist/es5/build/pdf')

exports.upload = functions.https.onRequest((request, response) => {
  // Add CORS header
  response.setHeader('Access-Control-Allow-Origin', 'http://localhost:8000')

  // Handle preflight request
  // send no content status for preflight requests
  if (request.method === 'OPTIONS') {
    response.set('Access-Control-Allow-Methods', 'POST')
    response.set('Access-Control-Allow-Headers', ['Content-Type', 'User-ID'])
    response.set('Access-Control-Max-Age', '3600')
    response.status(204)
    response.send('')
  } else {
    // Return method not allowed error for non post methods
    if (request.method.toLowerCase() !== 'post') {
      response.status(405).end()
      return
    }

    // Return bad request for request with types other than form-data
    if (
      `${request.header('Content-Type')}`.includes('multipart/form-data') !==
      true
    ) {
      response.status(400).end()
      return
    }

    const userID =
      request &&
      request.header('User-ID') &&
      request.header('User-ID').trim().length !== 0
        ? request.header('User-ID')
        : ''
    // Return request if no user id is present
    if (userID.length === 0) {
      response.status(401).end()
      return
    }

    const busboy = new Busboy({ headers: request.headers })

    let fileWritesPromise = []
    let fileSavePath = ''
    let fileName = ''

    // Runs on each file when uploaded
    busboy.on('file', (fieldName, file, unsafeFileName) => {
      // Treating all file name coming from client as unsafe and sanitizing it
      fileName = sanitize(unsafeFileName)

      // This temp file location will be Google cloud
      fileSavePath = path.join(os.tmpdir(), fileName)

      // Open the write stream for destination location
      const writeStream = fs.createWriteStream(fileSavePath)

      // pipe the incoming file stream to output temp file write stream
      file.pipe(writeStream)

      // Create a custom promise to track the end of file stream writing and wait
      // until files are written
      const fileWriteStatusPromise = new Promise((resolve, reject) => {
        file.on('end', () => {
          writeStream.end()
        })
        writeStream.on('finish', resolve)
        writeStream.on('error', reject)
      })

      fileWritesPromise.push(fileWriteStatusPromise)
    })

    // Runs after uploaded files are proccessed by busboy
    busboy.on('finish', async () => {
      try {
        // wait for promises to be resolved on file writing to disk,
        // before we go any further
        await Promise.all(fileWritesPromise)

        // convert saved file to buffer
        const fileBuffer = fs.readFileSync(fileSavePath)

        const pdfFileDocumentProxy = await pdfjs.getDocument(fileBuffer).promise
        const totalPagesInPDF = pdfFileDocumentProxy.numPages

        let fileInPDFParsedPromises = []

        // Loop through all pages and read text, page number always start from 1 unlike arrays
        for (let pageNumber = 1; pageNumber < totalPagesInPDF; pageNumber++) {
          const pageDocumentProxy = await pdfFileDocumentProxy.getPage(
            pageNumber,
          )

          // extract all text tokens from the PDF
          const pageTokenText = await pageDocumentProxy.getTextContent()

          // convert one by one from token to actual text
          let pageText = ''
          pageTokenText.items.forEach(token => {
            pageText = pageText + token.str
          })

          fileInPDFParsedPromises.push(pageText)
        }

        // since we are using async in for loop, we are waiting for all of the pdf text extractions
        // to be completed before we get out final text
        const pdfFileTextInArray = await Promise.all(fileInPDFParsedPromises)
        const pdfFileText = pdfFileTextInArray.join(' ')

        // delete the file saved temporarily disk, since we dont need it now
        fs.unlinkSync(fileSavePath)

        const currentDateTime = new Date()
        const completedAt = currentDateTime.toISOString()

        response.status(201)
        response
          .send({
            data: {
              fileName,
              userID,
              completedAt,
            },
            successMessage: 'File processed successfully',
            successCode: 'pf-201-1',
          })
          .end()
      } catch (err) {
        console.error(err)
        response.status(500).end()
      }
    })

    busboy.end(request.rawBody)
  }
})
