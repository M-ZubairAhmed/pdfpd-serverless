const functions = require('firebase-functions')
const path = require('path')
const os = require('os')
const fs = require('fs')
const Busboy = require('busboy')
const sanitize = require('sanitize-filename')
const pdfjs = require('pdfjs-dist/es5/build/pdf')
const firebaseAdmin = require('firebase-admin')

firebaseAdmin.initializeApp()
const firebaseDB = firebaseAdmin.firestore()

exports.upload = functions.https.onRequest((request, response) => {
  // Add CORS header
  response.setHeader('Access-Control-Allow-Origin', 'https://pdfdp.netlify.app')

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
      response.status(405)
      response
        .send({
          data: {},
          message: 'Invalid method',
        })
        .end()
      return
    }

    // Return bad request for request with types other than form-data
    if (
      `${request.header('Content-Type')}`.includes('multipart/form-data') !==
      true
    ) {
      response.status(415)
      response
        .send({
          data: {},
          message: 'Invalid content-type',
        })
        .end()
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
      response.status(401)
      response
        .send({
          data: {},
          message: 'Missing user ID',
        })
        .end()
      return
    }

    // 10 mb limit since gcp larger size will time out since we are temp storing in memory
    // instead of external data storage
    const TEN_MEGA_BYTES = 10 * 1024 * 1024

    const busboy = new Busboy({
      headers: request.headers,
      limits: { fileSize: TEN_MEGA_BYTES },
    })

    let fileWritesPromise = []
    let fileSavePath = ''
    let fileName = ''
    let fileID = ''

    // Runs on each file when uploaded
    busboy.on('file', (fieldName, file, unsafeFileName, encoding, mimetype) => {
      // Treating all file name coming from client as unsafe and sanitizing it
      fileName = sanitize(unsafeFileName)
      fileID = fieldName

      if (mimetype !== 'application/pdf') {
        response.status(400)
        response
          .send({
            data: {},
            message: 'Invalid PDF',
          })
          .end()
        return
      }

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
        const fileText = pdfFileTextInArray.join(' ')

        // No resultant parsed text
        if (fileText.trim().length === 0) {
          throw new Error('Text empty')
        }

        const completedAt = firebaseAdmin.firestore.FieldValue.serverTimestamp()

        const pdfFileRef = firebaseDB.collection(userID).doc(fileName)
        await pdfFileRef.set({
          fileID: fileID,
          fileName,
          userID,
          completedAt,
          fileText,
        })

        // delete the file saved temporarily disk, since we dont need it now
        fs.unlinkSync(fileSavePath)

        response.status(201)
        response
          .send({
            data: {
              fileName,
              userID,
            },
            message: 'File processed successfully',
          })
          .end()
      } catch (err) {
        functions.logger.warn('err in processing', err)
        response.status(500)
        response
          .send({
            data: {},
            message: 'Processing failed',
          })
          .end()
      }
    })

    busboy.end(request.rawBody)
  }
})
