import { calendar_v3, google } from 'googleapis'
import { OAuth2Client } from 'googleapis-common'
import { Credentials } from 'google-auth-library'

export class OAuth {
  public OAuthClient!: OAuth2Client

  constructor() {
    this.OAuthClient = new google.auth.OAuth2(
      process.env.CLIENT_ID,
      process.env.CLIENT_SECRET,
      process.env.GOOGLE_CALLBACK_URL
    )
  }

  public generateAuthUrl(config: object) {
    return this.OAuthClient.generateAuthUrl(config)
  }

  public async getToken(code: string) {
    return await this.OAuthClient.getToken(code)
  }

  public setCredentials(credentials: Credentials) {
    this.OAuthClient.setCredentials(credentials)
  }

  public async refreshAccessToken() {
    return await this.OAuthClient.refreshAccessToken()
  }

  public async getEventsList(
    instance: calendar_v3.Calendar,
    calendarID: string,
    minTime: Date | string,
    maxResults: number
  ): Promise<object[] | object> {
    let res,
      ok = false

    try {
      res = await instance.events.list({
        calendarId: calendarID,
        timeMin: minTime.toString(),
        maxResults,
        singleEvents: true,
        orderBy: 'startTime',
      })

      ok = true
    } catch (err) {
      ok = false
    }

    if (res && ok) {
      if (res.data.items) return res.data.items
      else return []
    } else return []
  }
}
