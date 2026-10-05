const clients = []

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of clients) res.write(msg)
}

function addClient(res) {
  clients.push(res)
  res.on('close', () => {
    const i = clients.indexOf(res)
    if (i >= 0) clients.splice(i, 1)
  })
}

module.exports = { broadcast, addClient }