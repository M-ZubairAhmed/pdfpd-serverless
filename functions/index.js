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
    response.set('Access-Control-Allow-Methods', 'GET')
    response.set('Access-Control-Allow-Headers', 'Content-Type')
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

    const busboy = new Busboy({ headers: request.headers })

    let fileWritesPromise = []
    let fileTempPath = ''

    // Runs on each file when uploaded
    busboy.on('file', (fieldName, file, unsafeFileName) => {
      // Treating all file name coming from client as unsafe and sanitizing it
      const fileName = sanitize(unsafeFileName)

      // This temp file location will be Google cloud
      const tempFileSavingDir = os.tmpdir()
      fileTempPath = path.join(tempFileSavingDir, fileName)

      // Start writing the file in the temp location
      const writeStream = fs.createWriteStream(fileTempPath)
      file.pipe(writeStream)

      // Create a custom promise to track the end of file writing
      const fileWriteStatusPromise = new Promise((resolve, reject) => {
        file.on('end', () => {
          writeStream.end()
        })
        writeStream.on('finish', resolve)
        writeStream.on('error', reject)
      })

      fileWritesPromise.push(fileWriteStatusPromise)
    })

    busboy.on('finish', async () => {
      try {
        // wait for finishing file writing to disk
        await Promise.all(fileWritesPromise)

        // convert saved file to buffer
        const fileBuffer = fs.readFileSync(fileTempPath)

        const pdfFileDocumentProxy = await pdfjs.getDocument(fileBuffer).promise
        const totalPagesInPDF = pdfFileDocumentProxy.numPages

        let fileInPDFParsedPromises = []

        // Loop through all pages and read text, page number always start from 1 unlike arrays
        for (let pageNumber = 1; pageNumber < totalPagesInPDF; pageNumber++) {
          const pageDocumentProxy = await pdfFileDocumentProxy.getPage(
            pageNumber,
          )
          const pageTokenText = await pageDocumentProxy.getTextContent()

          let pageText = ''
          pageTokenText.items.forEach(token => {
            pageText = pageText + token.str
          })

          fileInPDFParsedPromises.push(pageText)
        }

        const pdfFileTextInArray = await Promise.all(fileInPDFParsedPromises)
        const pdfFileText = pdfFileTextInArray.join(' ')

        // delete the file from the disk
        fs.unlinkSync(fileTempPath)

        response.status(201)
        response.send(pdfFileText).end()
      } catch (err) {
        console.error(err)
        response.status(500).end()
      }
    })

    busboy.end(request.rawBody)
  }
})
