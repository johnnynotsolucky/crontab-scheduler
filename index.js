const fs = require('fs')
const { exec } = require('child_process')
const xs = require('xstream').default
const scheduler = require('node-schedule')

const FILENAME = `${process.env.HOME}/.scheduler`

const createIfNotExist = (filename) => {
  // XXX try...catch..? Must be another way.
  try {
    fs.statSync(filename)
  } catch (e) {
    const fd = fs.openSync(filename, 'w')
    fs.closeSync(fd)
  }
}

const readFile = filename =>
  xs.create({
    start: listener => {
      createIfNotExist(filename)
      fs.readFile(filename, {flag: 'r+'}, (err, data) => {
        if (!err) {
          listener.next(data.toString())
        }
      })
    },
    stop: () => {}
  })

const watchConfig = filename => xs.create({
  start: (listener) => {
    createIfNotExist(filename)
    return fs.watch(filename, () => listener.next(filename))
  },
  stop: () => {}
})

const fileData = filename => xs.merge(
  watchConfig(filename)
    .map(readFile)
    .flatten(),
  readFile(filename)
)

const config = data$ =>
  data$
  .map(data => data.split(/\n/).filter(s => s && s.length > 0))
  .map(schedules =>
    schedules.map(item => {
      const parts = item.split(/ /)
      const schedule = parts.filter((_, i) => i < 5).join(' ')
      const instruction = parts.filter((_, i) => i >= 5).join(' ')
      return { schedule, instruction }
    }))

const schedule = config$ =>
  config$
  .map((schedules) => {
    const jobs = []
    return xs.create({
      start:(listener) => {
        schedules.forEach((item) => {
          const job = scheduler.scheduleJob(item.schedule, () => {
            listener.next(item)
          })
          jobs.push(job)
        })
      },
      stop: () => {
        jobs.forEach((job) => job.cancel())
      }
    })
  })
  .flatten()

const instructionProc = end$ => schedule$ =>
  schedule$
  .map((schedule) => {
    let proc
    const instructionProc$ = xs.create({
      start: (listener) => {
        proc = exec(schedule.instruction, (err, stdout, stderr) => {
          if (err) {
            listener.next({ error: err })
          } else {
            listener.next({ stdout, stderr })
          }
        })
      },
      stop: () => {
        proc.kill()
      }
    })
    .endWhen(end$)

    return {
      schedule: schedule.schedule,
      instruction: schedule.instruction,
      proc: instructionProc$
    }
  })

function create(filename) {
  const configData$ = fileData(filename)
  const config$ = configData$.compose(config)
  const schedule$ = config$.compose(schedule)
  const procEndOnConfig = instructionProc(watchConfig(filename))
  const proc$ = schedule$.compose(procEndOnConfig)

  return {
    config: config$,
    schedule: schedule$,
    instruction: proc$
  }
}

module.exports = create
exports = module.exports
exports.createIfNotExist = createIfNotExist
exports.readFile = readFile
exports.watchConfig = watchConfig
exports.fileData = fileData
exports.config = config
exports.schedule = schedule
exports.instructionProc = instructionProc
