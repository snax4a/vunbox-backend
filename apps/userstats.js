const Database = require('../models')
const highland = require('highland')
const { Cache, Defaults } = require('../libs/stats')

// process events creating stats by userid.

module.exports = async config => {
  const { events, userstats, users, items, cases } = await Database(
    config.rethink
  )

  let totalEvents = 0
  const statsCache = Cache(Defaults.user)
  const boxes = {}

  const handleCaseEvent = async event => {
    // simple cache to optimize processing speed...
    if (!boxes[event.caseId]) {
      event.box = await cases.get(event.caseId)
      boxes[event.caseId] = event.box
    } else {
      event.box = boxes[event.caseId]
    }

    users.save(event.userId, {
      username: event.userName,
      avatar: event.userAvatar,
    })

    items.upsert({
      id: event.item.name,
      name: event.item.name,
      price: event.item.price,
      rarity: event.item.rarity,
      image: event.item.image,
    })

    return [
      statsCache.processCaseEvent(event.userId, event),
      statsCache.processAdditionalCaseStats(event.userId, event),
      // statsCache.processCaseEvent('global', event),
      // statsCache.processAdditionalCaseStats('global', event),
    ]
  }

  const handleTradeEvent = async event => {
    const results = []

    // sometimes sender is null
    if (event.sender) {
      users.save(event.recipient.userId, {
        username: event.recipient.userName,
      })
      const stats = statsCache.processTradeEvent(event.sender.userId, event)

      //save update to array of pending writes.
      results.push(stats)
    }

    if (event.recipient) {
      users.save(event.sender.userId, {
        username: event.sender.userName,
      })
      const stats = statsCache.processTradeEvent(event.recipient.userId, event)

      //save update to array of pending writes.
      results.push(stats)
    }

    // flush writes into the stream.
    // return [...results, statsCache.processTradeEvent('global', event)]
    return [...results]
  }

  // route the event type to the correct topic processor.
  async function handleEvent(event) {
    console.log('handleEvent:', ++totalEvents, event.id)
    switch (event.type) {
      case 'case-opened':
        return handleCaseEvent(event)
      case 'trade-offers':
        return handleTradeEvent(event)
    }
  }

  // buffer changes
  const realtimeBuffer = highland()

  // cache all realtime events while we resume.
  events
    .changes()
    .map(row => row.new_val)
    .compact()
    .pipe(realtimeBuffer)

  // pause, resume service from memory
  const last = await userstats
    .streamSorted()
    .map(statsCache.set)
    .errors(err => {
      console.error('Error Resuming cache:', err)
      process.exit(1)
    })
    .last()
    .toPromise(Promise)

  // process all events from last mutation to now.
  await events
    .streamFrom(last.updated)
    .filter(row => row.item.price)
    .map(handleEvent)
    .flatMap(highland)
    .errors(err => {
      console.error(err)
      process.exit(1)
    })
    .last()
    .toPromise(Promise)

  // dump cache to db
  await statsCache
    .highland()
    .map(userstats.upsert)
    .flatMap(highland)
    .errors(err => {
      console.error(err)
      process.exit(1)
    })
    .last()
    .toPromise(Promise)

  // process realtime events forever.
  realtimeBuffer
    .map(handleEvent)
    .flatMap(highland)
    .map(userstats.upsert)
    .flatMap(highland)
    .errors(err => {
      console.error(err)
      // process.exit(1)
    })
    .resume()

  return {
    async openStream() {
      return realtimeBuffer.toPromise(Promise)
    },
    async list() {
      return statsCache.list()
    },
  }
}
