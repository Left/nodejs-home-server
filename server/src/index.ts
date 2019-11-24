import app from './app'

const port = 8080

app.listen(port, (err: Error) => {
  if (err) {
    return console.log(err)
  }

  return console.log(`server is listening on ${port}`)
})

