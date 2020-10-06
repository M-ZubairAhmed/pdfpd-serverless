const functions = require('firebase-functions');

exports.upload = functions.https.onRequest((request, response) => {
  // functions.logger.info("Hello logs!", process.env.NODE_ENV);


  response.setHeader('Access-Control-Allow-Origin', 'http://localhost:8000')

  // Handle preflight request
  if (request.method === 'OPTIONS') {
    response.set('Access-Control-Allow-Methods', 'GET');
    response.set('Access-Control-Allow-Headers', 'Content-Type');
    response.set('Access-Control-Max-Age', '3600');
    response.status(204)
    // send no content status for preflight requests
    response.send('');
  } else {
    // Actual api request
    // Do not allow any other method except for POST
    if(request.method !== "POST"){
      response.status(405)
      response.send("Method not allowed").end()
    }else {
      response.send('Hello World!');
    }
  }
});
