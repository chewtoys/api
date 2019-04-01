import * as crypto from 'crypto'
import * as express from 'express'
import { GaxiosResponse } from 'gaxios'
import {google} from 'googleapis'
import moment from 'moment'

import { Service, StandaloneServices } from '../service'
import { APIerror, APIrequest, APIresponse, date, Mentor, Slot } from '../types'
import { calendar, sql } from '../utils'

export class MentorService extends Service {
  constructor(app: express.Application, standaloneServices: StandaloneServices) {
    super(app, standaloneServices)

    if (this.logger) this.logger.verbose('Mentor service loaded')
  }

  /**
   * @description Fetches mentor info based on keycode
   * @param {express.Request} req
   * @param {express.Response} res
   */
  public async get(req: express.Request , res: express.Response) {
    let response: APIresponse = {
        ok: 1,
        code: 200,
      }
    let error: APIerror

    try {
      let sqlQuery: string
      let params: string[] | string | date[]
      let result

      // fetch mentor general info
      [sqlQuery, params] = sql.createSQLqueryFromJSON('SELECT', 'users',
        {
          keycode: req.params.keycode,
          type: 'mentor',
        })

      const mentorInfo: Mentor = await this.database.query(sqlQuery, params)
      if (!Object.keys(mentorInfo).length) {
        error = {
          api: true,
          code: 404,
          message: 'Mentor not found',
          friendlyMessage: 'There is no mentor with the provided keycode',
        }

        throw error
      }
      response.mentor = mentorInfo

      if (mentorInfo.googleAccessToken) { // FIXME - Improve this, it's slow and inneficient
        // Relies on Google - delete slots not on Google

        const mentorUid = mentorInfo.uid

        this.oauth.setCredentials({
          access_token: mentorInfo.googleAccessToken,
          refresh_token: mentorInfo.googleRefreshToken,
        })

        const googleCalendar = google.calendar({
          version: 'v3',
        })

        google.options({
          auth: this.oauth.OAuthClient,
        })

        const googleResponse = await googleCalendar.events.list({
          calendarId: mentorInfo.upframeCalendarId,
          timeMin: (new Date()).toISOString(),
          maxResults: 2400, // I believe the max is 2500
          singleEvents: true,
          orderBy: 'startTime',
        })

        const googleEvents = googleResponse.data.items ? googleResponse.data.items : []

        if (googleEvents.length > 0) {
          const getAllTimeSlotsQuery = 'SELECT * FROM timeSlots WHERE mentorUID = ?'
          let dbSlots = await this.database.query(getAllTimeSlotsQuery, mentorUid)
          if (!dbSlots.length) {
            dbSlots = [dbSlots]
          }
          const finalDbSlotsToRemove = dbSlots.filter((slot) => {
            return !googleEvents.some((googleEvent) => googleEvent.id === slot.sid)
          })
          const deleteTimeSlotQuery = 'SELECT deleteSlot(?, ?)'
          for (const slot of finalDbSlotsToRemove) {
            await this.database.query(deleteTimeSlotQuery, [slot.sid, mentorUid])
          }
        } else {
          const deleteAllTimeSlotsQuery = 'DELETE FROM timeSlots WHERE mentorUID = ?'
          await this.database.query(deleteAllTimeSlotsQuery, mentorUid)
        }
      }

      // fetch mentor time slots
      sqlQuery = 'SELECT * FROM timeSlots WHERE mentorUID = ?'
      params = [response.mentor.uid]

      let mentorSlots = await this.database.query(sqlQuery, params)

      if (mentorSlots.sid) { // FIXME - I believe this breaks recurrency
        response.mentor.slots = [mentorSlots]
      } else if (!Array.isArray(mentorSlots)) {
        response.mentor.slots = []
      } else {
        const verified: string[] = []

        // generate slots from today to 7 days from now
        mentorSlots = calendar.automaticGenerate(mentorSlots, moment().toDate(), moment().add(7, 'd').toDate())

        // filter available slots from all slots
        for (const slot of mentorSlots) {
          if (verified.includes(slot.sid)) continue

          // check if there any meetup refering to this slot and its space in time
          sqlQuery = `SELECT COUNT(*) FROM meetups WHERE sid = ? AND status = "confirmed"
         AND TIMESTAMP(start) BETWEEN TIMESTAMP(?) AND TIMESTAMP(?)`
          params = [slot.sid, moment(slot.start).toDate(), moment(slot.start).add(1, 'h').toDate()]
          result = await this.database.query(sqlQuery, params)
          if ( result['COUNT(*)'] ) {
            // there is a confirmed meetup on that space in time
            // so let's filter all the slots and remove the slot starting
            // at that time
            mentorSlots = mentorSlots.filter((eachSlot) => eachSlot.start.getTime() !== slot.start.getTime())
          }
        }
        // Mentor slots have the following props
        // sid
        // mentorUID
        // start
        // end
        // recurrency
        mentorSlots = mentorSlots.filter((slot) => { // Dont send slots in the past
          return new Date() < moment(slot.start).toDate()
        })
        mentorSlots.sort((a, b) => { // Sort the slots chronologically
          if (moment(a.start).toDate() < moment(b.start).toDate()) {
            return -1
          }

          if (moment(a.start).toDate() > moment(b.start).toDate()) {
            return 1
          }

          return 0
        })

        response.mentor.slots = mentorSlots
      }
    } catch (err) {
      response = {
        ok: 0,
        code: 500,
      }

      if (err.api) {
        response.code = err.code
        response.message = err.message
        response.friendlyMessage = err.friendlyMessage
      }
    }

    res.status(response.code).json(response)
  }

  /**
   * @description Returns all mentors on the platform
   * @param {express.Request} req Express request
   * @param {express.Response} res Express response
   */
  public async getAll(req: express.Request, res: express.Response) {
    let response: APIresponse = {
      ok: 1,
      code: 200,
    }
    let error: APIerror

    try {
      const sqlQuery = 'SELECT name, role, company, bio, tags, keycode, profilePic FROM users WHERE type = \'mentor\' AND newsfeed = \'Y\' ORDER BY RAND()'

      const mentorList = await this.database.query(sqlQuery)
      if (!Object.keys(mentorList).length) {
        error = {
          api: true,
          code: 404,
          message: 'Mentors not found',
          friendlyMessage: 'Mentors not found',
        }

        throw error
      }

      response.mentors = mentorList
    } catch (err) {
      response = {
        ok: 0,
        code: 500,
      }

      if (err.api) {
        response.code = err.code
        response.message = err.message
        response.friendlyMessage = err.friendlyMessage
      }
    }

    res.status(response.code).json(response)
  }

  /**
   * @description Fetches random mentors (max: 5)
   * @param {express.Request} req Express request
   * @param {express.Response} res Express response
   */
  public async getRandom(req: express.Request , res: express.Response) {
    let response: APIresponse = {
      ok: 1,
      code: 200,
    }
    let error: APIerror

    try {
      const sqlQuery = 'SELECT name, role, company, bio, tags, keycode, profilePic FROM users WHERE type = \'mentor\' ORDER BY RAND() LIMIT 5'

      const mentorList = await this.database.query(sqlQuery)
      if (!Object.keys(mentorList).length) {
        error = {
          api: true,
          code: 404,
          message: 'Mentors not found',
          friendlyMessage: 'Mentors not found',
        }

        throw error
      }

      response.mentors = shuffle(mentorList)
    } catch (err) {
      response = {
        ok: 0,
        code: 500,
      }

      if (err.api) {
        response.code = err.code
        response.message = err.message
        response.friendlyMessage = err.friendlyMessage
      }
    }

    res.status(response.code).json(response)
  }

  /**
   * @description Returns mentor's time slots. There are two possibilities here,
   * either the user is Google Synced and we need to take that into consideration,
   * or we simply don't care about that.
   * @param {APIrequest} req
   * @param {express.Response} res
   */
  public async getTimeSlots(req: APIrequest, res: express.Response) {
    let response: APIresponse = {
      ok: 1,
      code: 200,
    }
    let error: APIerror

    try {
      if (!req.jwt || !req.jwt.uid) {
        error = {
          api: true,
          code: 403,
          message: 'Insufficient permissions',
          friendlyMessage: 'There was a problem fetching your timeslots',
        }

        throw error
      }

      ////////////////////////////////////
      let firstSqlQuery: string
      let params: string[] | string | date[]
      [firstSqlQuery, params] = sql.createSQLqueryFromJSON('SELECT', 'users',
        {
          uid: req.jwt.uid,
          type: 'mentor',
        })

      const mentorInfo: Mentor = await this.database.query(firstSqlQuery, params)
      if (!Object.keys(mentorInfo).length) {
        error = {
          api: true,
          code: 404,
          message: 'Mentor not found',
          friendlyMessage: 'There is no mentor with the provided keycode',
        }

        throw error
      }
      response.mentor = mentorInfo

      if (mentorInfo.googleAccessToken) { // FIXME - Improve this, it's slow and inneficient
        // Relies on Google - delete slots not on Google

        const mentorUid = mentorInfo.uid

        this.oauth.setCredentials({
          access_token: mentorInfo.googleAccessToken,
          refresh_token: mentorInfo.googleRefreshToken,
        })

        const googleCalendar = google.calendar({
          version: 'v3',
        })

        google.options({
          auth: this.oauth.OAuthClient,
        })

        const googleResponse = await googleCalendar.events.list({
          calendarId: mentorInfo.upframeCalendarId,
          timeMin: (new Date()).toISOString(),
          maxResults: 2400, // I believe the max is 2500
          singleEvents: true,
          orderBy: 'startTime',
        })

        const googleEvents = googleResponse.data.items ? googleResponse.data.items : []

        if (googleEvents.length > 0) {
          const getAllTimeSlotsQuery = 'SELECT * FROM timeSlots WHERE mentorUID = ?'
          let dbSlots = await this.database.query(getAllTimeSlotsQuery, mentorUid)
          if (!dbSlots.length) {
            dbSlots = [dbSlots]
          }
          const finalDbSlotsToRemove = dbSlots.filter((slot) => {
            return !googleEvents.some((googleEvent) => googleEvent.id === slot.sid)
          })
          const deleteTimeSlotQuery = 'SELECT deleteSlot(?, ?)'
          for (const slot of finalDbSlotsToRemove) {
            await this.database.query(deleteTimeSlotQuery, [slot.sid, mentorUid])
          }
        } else {
          const deleteAllTimeSlotsQuery = 'DELETE FROM timeSlots WHERE mentorUID = ?'
          await this.database.query(deleteAllTimeSlotsQuery, mentorUid)
        }
      }
      ////////////////////////////////////

      const sqlQuery = 'SELECT * FROM timeSlots WHERE mentorUID = ?'
      const startDate = req.query.start
      const endDate = req.query.end

      const slots: Slot[] = await this.database.query(sqlQuery, [req.jwt.uid])
      if ( !Object.keys(slots).length || (Array.isArray(slots) && !slots.length) ) {
        error = {
          api: true,
          code: 404,
          message: 'Slots not found',
          friendlyMessage: 'This mentor has no slots',
        }

        throw error
      }

      let genSlots: Slot[] = []
      if (Array.isArray(slots)) {
        genSlots = calendar.automaticGenerate(slots).filter((slot) => {
          let ok = true
          // verify if slot start is after the defined minimum start Date
          if (new Date(startDate)) {
            if (new Date(startDate).getTime() > new Date(slot.start).getTime()) ok = false
          }
          // verify if slot end is before the defined maximum end Date
          if (new Date(endDate)) {
            if (new Date(endDate).getTime() < new Date(slot.end).getTime()) ok = false
          }
          return ok
        })
      } else genSlots.push(slots)

      response.slots = genSlots
    } catch (err) {
      response = {
        ok: 0,
        code: 500,
      }

      if (err.api) {
        response.code = err.code
        response.message = err.message
        response.friendlyMessage = err.friendlyMessage
      }
    }

    res.status(response.code).json(response)
  }

  /**
   * @description Updates and creates mentor's time slots
   * @param {APIrequest} req
   * @param {express.Response} res
   */
  public async updateTimeSlots(req: APIrequest, res: express.Response) {
    let response: APIresponse = {
        ok: 1,
        code: 200,
      }
    let error: APIerror

    try {
      if (!req.jwt || !req.jwt.uid) {
        error = {
          api: true,
          code: 403,
          message: 'Forbidden',
          friendlyMessage: 'There was a problem updating your timeslots',
        }

        throw error
      }

      const deletedSlots: string[] = req.body.deleted
      const updatedSlots: Slot[] = req.body.updated
      const splitSlots: Slot[] = []
      let sqlQuery: string
      let params: string | string[]

      // fetch mentor info
      [sqlQuery, params] = sql.createSQLqueryFromJSON('SELECT', 'users', {uid: req.jwt.uid})
      const mentor: Mentor = await this.database.query(sqlQuery, params)

      // let's refresh google access token if the mentor has synced
      if (mentor.googleAccessToken || mentor.googleRefreshToken) {
        this.oauth.setCredentials({
          access_token: mentor.googleAccessToken,
          refresh_token: mentor.googleRefreshToken,
        })

        // const tokens = await this.oauth.refreshAccessToken()
        // if (!tokens.credentials.access_token) {
        //   error = {
        //     api: true,
        //     code: 500,
        //     message: 'Could not get updated access token',
        //     friendlyMessage: 'There was an error fetching the user\'s info',
        //   }
        //   throw error
        // }
      }

      // create Calendar instance
      const googleCalendar = google.calendar({
        version: 'v3',
      })
      // set google options
      google.options({
        auth: this.oauth.OAuthClient,
      })

      // delete events
      if (deletedSlots) {
        sqlQuery = 'SELECT deleteSlot(?, ?)'
        response.deleteOK = 1

        for (const slotID of deletedSlots) {
          try {
            googleCalendar.events.delete({
              calendarId: mentor.upframeCalendarId,
              eventId: slotID,
            })

            await this.database.query(sqlQuery, [slotID, req.jwt.uid])

          } catch (err) {
            response.ok = 0
            response.code = 500
            response.message = 'One or more time slots couldn\'t be deleted'
            response.deleteOK = 0
          }
        }
      }

      // try to update events
      if (updatedSlots) {
        sqlQuery = 'SELECT insertUpdateSlot(?, ?, ?, ?, ?)'
        response.updateOK = 1

        for (const slot of updatedSlots) {
          try {
            // calculate how many hours are between slot end and slot start
            // and determine how many 2h slots and 1h slots fill this better
            const hourDiff: number = moment(slot.end).diff(slot.start, 'hours')
            let twoHourSlots: number = Math.floor(hourDiff / 2)
            let oneHourSlots: number = Math.floor(hourDiff - (twoHourSlots * 2))

            // determine directly how many 30-min slots can fill
            let halfHourSlots: number = moment(slot.end).subtract(hourDiff, 'hours').diff(slot.start, 'minutes') / 30

            const it = moment(slot.start)
            const itStart = moment(slot.start)
            let mode: number = 2
            while (true) {
              if (twoHourSlots) {
                it.add('2', 'hours')
                twoHourSlots--
              } else if (oneHourSlots) {
                it.add('1', 'hours')
                mode = 1
                oneHourSlots--
              } else if (halfHourSlots) {
                it.add('30', 'minutes')
                mode = 0
                halfHourSlots--
              } else break

              const newSlot: Slot = {
                sid: crypto.randomBytes(20).toString('hex'),
                start: itStart.toDate(),
                end: it.toDate(),
                mentorUID: req.jwt.uid,
                recurrency: slot.recurrency,
              }

              // set next slot starting time
              if (mode === 2) itStart.add('2', 'hours')
              else if (mode === 1) itStart.add('1', 'hour')
              else if (mode === 0) itStart.add('30', 'minutes')

              // save slot to database
              await this.database.query(sqlQuery, [newSlot.sid,
                newSlot.mentorUID,
                newSlot.start,
                newSlot.end,
                newSlot.recurrency,
              ])

              // save event in mentor's Google Calendar
              await googleCalendar.events.insert({
                calendarId: mentor.upframeCalendarId,
                requestBody: {
                  summary: 'Upframe Free Time Slot',
                  start: {
                    dateTime: moment(newSlot.start).toISOString(),
                  },
                  end: {
                    dateTime: moment(newSlot.end).toISOString(),
                  },
                  description: 'Nice slot',
                  id: newSlot.sid,
                },
              })
                // .then((googleRes: GaxiosResponse) => {
                //   if (googleRes.status !== 200) {
                //     response.friendlyMessage = 'It was not possible to save slots in Google Calendar'
                //   }
                // })
              // }

              await this.database.query(sqlQuery, [slot.sid, req.jwt.uid, slot.start, slot.end, slot.recurrency])
            }
          } catch (err) {
            response.ok = 0
            response.code = 500
            response.message = 'One or more time slots couldn\'t be updated'
            response.updateOK = 0
          }
        }
      }
    } catch (err) {
      response = {
        ok: 0,
        code: 500,
        deleteOK: 0,
        updateOK: 0,
      }

      if (err.api) {
        response.code = err.code
        response.message = err.message
        response.friendlyMessage = err.friendlyMessage
      }
    }

    res.status(response.code).json(response)
  }

  /**
   * @description Verify if
   * @param {express.Request} req
   * @param {express.Response} res
   */
  public async verify(req: express.Request , res: express.Response) {
    let response: APIresponse = {
        ok: 1,
        code: 200,
      }
    let error: APIerror

    try {
      const check = req.query.keycode ? 'keycode' : 'uniqueid'
      const value = req.query.keycode ? `"${req.query.keycode}"` : req.query.uniqueid
      const sqlQuery = `SELECT * FROM onboarding WHERE ${check} = ${value}`

      const onboardingInvite = await this.database.query(sqlQuery)
      if (!Object.keys(onboardingInvite).length) {
        error = {
          api: true,
          code: 404,
          message: 'Onboarding invite not found',
          friendlyMessage: 'There is no onboarding invite with this unique ID',
        }

        throw error
      }

    } catch (err) {
      response = {
        ok: 0,
        code: 500,
      }

      if (err.api) {
        response.code = err.code
        response.message = err.message
        response.friendlyMessage = err.friendlyMessage
      }
    }

    res.status(response.code).json(response)
  }

}

function shuffle(a: any[]) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }

  return a.slice(0, 2)
}
