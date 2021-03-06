import * as bcrypt from 'bcryptjs'

import * as models from '../models'

/**
 * @param {string} action
 * @param {string} table
 * @param {object} fjson
 * @param {object} sjson
 */
export function createSQLqueryFromJSON(
  action: string,
  table: string,
  fjson: object,
  sjson?: object
): [string, string[]] {
  let query: string = ''
  let params: string[] = []

  switch (action) {
    case 'INSERT':
      ;[query, params] = createInsertQuery(table, fjson)
      break
    case 'UPDATE':
      if (sjson) {
        ;[query, params] = createUpdateQuery(table, fjson, sjson)
      }
      break
    case 'SELECT':
      ;[query, params] = createSelectQuery(table, fjson)
      break
  }

  if (query && params) {
    return [query, params]
  } else return ['', []]
}

/**
 * @description Creates INSERT SQL query using table name and JSON which contains info
 * @param {string} table
 * @param {object} json
 */
function createInsertQuery(table: string, json: object): [string, string[]] {
  let query = `INSERT INTO ${table} (${Object.keys(
    Array.isArray(json) ? json[0] : json
  ).join()}) VALUES ${(Array.isArray(json) ? json : [json])
    .map(
      v =>
        `(${Array(Object.values(v).length)
          .fill('?')
          .join()})`
    )
    .join()}`

  return [query, (Array.isArray(json) ? json : [json]).flatMap(Object.values)]
}

/**
 * @description Creates UPDATE SQL query using table name, JSON which contains info and JSON that identifies record
 * @param {string} table
 * @param {object} newJson - JSON object with the new information
 * @param {object} whereJson - JSON object with the information needed to indentify record
 */
function createUpdateQuery(
  table: string,
  newJson: any,
  whereJson: object
): [string, string[]] {
  let sqlQuery = `UPDATE ${table} SET `
  const params: string[] = []

  for (const prop of Object.keys(newJson)) {
    sqlQuery += prop + ' = ?, '

    if (prop === 'password') {
      // hash password
      const salt = bcrypt.genSaltSync(10)
      newJson[prop] = bcrypt.hashSync(newJson[prop], salt)
    }

    params.push(newJson[prop])
  }
  sqlQuery = sqlQuery.slice(0, -2) + ' WHERE '

  for (const prop of Object.keys(whereJson)) {
    sqlQuery += prop + '= ? AND '

    params.push(whereJson[prop])
  }
  sqlQuery = sqlQuery.slice(0, -5)

  return [sqlQuery, params]
}

/**
 * @description Creates SELECT SQL query using table name and JSON which identifies record
 * @param {string} table
 * @param {object} whereJSON
 */
function createSelectQuery(
  table: string,
  whereJSON: object
): [string, string[]] {
  const fields: string[] = models.get(table)

  let sqlQuery = 'SELECT '
  const params: string[] = []

  for (const fieldName of fields) {
    sqlQuery += `${fieldName}, `
  }
  if (table !== 'mentors')
    sqlQuery = sqlQuery.slice(0, -2) + ` FROM ${table} WHERE `
  else sqlQuery = sqlQuery.slice(0, -2) + ' FROM users WHERE '

  for (const prop of Object.keys(whereJSON)) {
    if (fields.includes(prop)) {
      sqlQuery += `${prop} = ? AND `
      params.push(whereJSON[prop])
    }
  }
  sqlQuery = sqlQuery.slice(0, -5)

  return [sqlQuery, params]
}
