const express = require('express')
const router = express.Router()

router.get('/me', (req, res) => {
  res.status(200).send('Tudo correu bem')
})

router.post('/me', (req, res) => {
  res.status(200).send('Tudo correu bem')
})

router.post('/image', (req, res) => {
  res.status(200).send('Tudo correu bem')
})

module.exports = router;