import * as crypto from 'crypto'
import * as express from 'express'
import moment from 'moment'

import { APIrequest, APIRequestBody, APIresponse, APIerror, Meetup } from '../types'
import { sql, calendar } from '../utils'

import { service } from '../service'

export class MeetupService extends service {
  constructor(app: express.Application) {
    super(app)

    if(this.logger) this.logger.verbose('Meetup service loaded')
  }

  /**
   * @description Returns all user's events (confirmed + pending) 
   * @param {APIrequest} req 
   * @param {express.Response} res 
   */
  async get(req: APIrequest, res: express.Response) {
    let response: APIresponse = {
        ok: 1,
        code: 200
      },
      sqlQuery = 'SELECT * FROM meetups WHERE menteeUID = ?'

    try {
      let rows: Meetup[]
      if(req.jwt) {
        rows = (await this.database.query(sqlQuery, [req.jwt.uid]))[0]
        if (!rows.length) {
          let err: APIerror = {
            code: 404,
            message: 'Events not found',
            friendlyMessage: 'You have no events'
          }
          throw err
        }

        response.events = rows
      }
    } catch (err) {
      response.ok = 0
      response.code = 400

      if(err.APIerr) {
        response.code = err.errorCode
        response.message = err.errorMessage
      }
    }

    res.status(response.code).json(response)
  }

  /**
   * @description Creates a pending meetup which the mentor has to confirm by email
   * @param {APIrequest} req 
   * @param {express.Response} res 
   */
  async create(req: APIrequest, res: express.Response) {
    let json: APIRequestBody = Object.assign({}, req.body),
      sqlQuery: string = '',
      response: APIresponse = {
        ok: 1,
        code: 200
      }

    try {
      if(!req.jwt || !req.jwt.uid) throw 403

      let meetup: Meetup = {
        menteeUID: req.jwt.uid || "putas",
        mid: crypto.randomBytes(20).toString('hex'),
        sid: json.sid,
        location: json.location,
        start: json.start
      }

      if(!meetup.mid) {
        let err: APIerror = {
          code: 500,
          message: 'Internal Server Error during Meetup ID creation',
          friendlyMessage: 'It was not possible to complete your request.'
        }

        throw err
      }

      // get Slot info using Slot ID
      sqlQuery = 'SELECT * FROM timeSlots WHERE sid = ?'
      let [slots] = (await this.database.query(sqlQuery, [meetup.sid]))
      if(!slots.length) throw { APIerr: false, errorCode: 404, errorMessage: 'Slot not found' }
      // verify if the user requesting the meetup is the mentor itself
      if(slots[0].mentorUID === meetup.menteeUID) throw { APIerr: false, errorCode: 400, errorMessage: 'A user cannot set a meetup with itself'}

      meetup.mentorUID = slots[0].mentorUID

      // verify if the requested meetup location is valid (if the mentor has this location as a favorite place)
      sqlQuery = 'SELECT * FROM users WHERE uid = ?'
      if( (await this.database.query(sqlQuery, [meetup.mentorUID]))[0][0].location != meetup.location) {
        throw { APIerr: false, errorCode: 400, errorMessage: 'Slot location is invalid' }
      }

      // verify if slot is already occupied
      let genSlots = calendar.automaticGenerate(slots, moment(meetup.start).add(1, 'd').toDate())
      for(let slot of genSlots) {
        // find slot whose date matches the requested meetup date
        if(meetup.start && new Date(slot.start).getTime() == new Date(meetup.start).getTime()) {
          // verify if slot is free (there is no meetup with status confirmed)
          sqlQuery = 'SELECT * FROM meetups WHERE sid = ? AND start = TIMESTAMP(?) AND status = "confirmed"'
          let [freeSlots] = (await this.database.query(sqlQuery, [meetup.sid, meetup.start]))
          if(freeSlots.length) throw { APIerr: false, errorCode: 404, errorMessage: 'There is no slot available' }
          else {
            // verify if user has already made a meetup request to that space in time
            sqlQuery = 'SELECT * FROM meetups WHERE sid = ? AND start = TIMESTAMP(?) AND status = "pending" AND menteeUID = ?'
            let [userRequests] = (await this.database.query(sqlQuery, [meetup.sid, meetup.start, meetup.menteeUID]))
            if(userRequests.length) throw { APIerr: true, errorCode: 400, errorMessage: 'One user can only make one request for each slot' }
            
            // finally, let's insert a new meetup request
            let [sqlQuery2, params] = await sql.createSQLqueryFromJSON('INSERT', 'meetups', meetup)
            let [rows] = await this.database.query(sqlQuery2, params)
            if(!rows.affectedRows) throw { APIerr: true, errorCode: 500, errorMessage: 'Internal Server Error' }
            
            // send email
            let result = await this.mail.sendMeetupInvitation(meetup.mid)
            if(result) throw 500
          }
        }
      }
    } catch (err) {
      response.ok = 0
      response.code = 400

      if(err.APIerr) {
        response.code = err.errorCode
        response.message = err.errorMessage
      }
    }

    res.status(response.code).json(response)
  }

  /**
   * @description Confirms meetup
   * @param {APIrequest} req 
   * @param {express.Response} res 
   */
  async confirm(req: APIrequest, res: express.Response) {
    let response: APIresponse = {
      ok: 1,
      code: 200
    }

    try {
      if(!req.jwt || !req.jwt.uid) throw 403

      let [sqlQuery, params] = sql.createSQLqueryFromJSON('SELECT', 'meetups', { mid: req.query.meetup, mentorUID: req.jwt.uid, status: 'pending' })
      let meetup = (await this.database.query(sqlQuery, params))[0]
      if(!meetup.length) throw { APIerr: false, errorCode: 404, errorMessage: 'Meetup not found or has already been confirmed' }
      
      let [sqlQuery2, params2] = sql.createSQLqueryFromJSON('UPDATE', 'meetups', { status: 'confirmed' }, { mid: req.query.meetup})
      let result = (await this.database.query(sqlQuery2, params2))[0]
      
      result = await this.mail.sendMeetupConfirmation(req.query.meetup)
      if(result) throw { APIerr: true, errorCode: 500, errorMessage: 'Error sending email confirmation' }
    } catch (err) {
      response.ok = 0
      response.code = 400

      if(err.errorCode == 404) {
        response.ok = 0
        response.code = 404
        response.message = err.errorMessage
      }
      
      if(err.APIerr) {
        response.code = err.errorCode
        response.message = err.errorMessage
      }
    }

    res.status(response.code).json(response)
  }
  
  /**
   * 
   * @param {APIrequest} req 
   * @param {express.Response} res 
   */
  async refuse(req: APIrequest, res: express.Response) {
    let response: APIresponse = {
      ok: 1,
      code: 200
    }

    try {
      if(!req.jwt || !req.jwt.uid) throw 403

      let [sqlQuery, params] = sql.createSQLqueryFromJSON('SELECT', 'meetups', { mid: req.query.meetup, mentorUID: req.jwt.uid, status: 'pending' })
      let meetup = (await this.database.query(sqlQuery, params))[0]
      if(!meetup.length) throw { APIerr: false, errorCode: 404, errorMessage: 'Meetup not found or has already been refused' }

      let [sqlQuery2, params2] = sql.createSQLqueryFromJSON('UPDATE', 'meetups', { status: 'refused' }, { mid: req.query.meetup })
      await this.database.query(sqlQuery2, params2)
    } catch (err) {
      response.ok = 0
      response.code = 400

      if(err.errorCode == 404) {
        response.code = err.errorCode
        response.message = err.errorMessage
      }
    }

    res.status(response.code).json(response)
  }
}