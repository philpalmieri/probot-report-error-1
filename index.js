const crypto = require('crypto')

class Lifeguard {
  constructor (options = {}) {
    this.title = options.title || 'Probot integration problem'
    this.body = options.body || 'An error occurred'
    this.labels = options.labels || []
    this.reopen = options.reopen || false
    // I decided not to support passing a milestone or assignees
    // since that opens the door for errors when creating the issue if the data provided is wrong
    // and for an error reporting tool it is an important requirement not to fail
    // when reporting an error :)
  }

  /**
   * Calculate a string representation of the error with as much information as possible
   * @param {*} err
   */
  errorToString (err) {
    return err.stack || err.message || String(err) || 'Unknown error'
  }

  /**
   * Calculate a hash of the string representation of the error in order to
   * not create multiple issues for the same problem. The hash will be in the title
   * of the issue according to the requirements
   * @param {*} string
   */
  hash (string) {
    return crypto.createHash('sha256')
      .update(string)
      .digest('hex')
      .substring(0, 8)
  }

  /**
   * We are creating and editing issues, which trigger webhook events.
   * With this check we will ignore those events generated by ourselves
   * to prevent an infinite integration loop.
   *
   * My first idea was to check context.payload.sender, but I couldn't find a way
   * in the probot API to know the login or id of the current bot to compare it with the sender
   * information.
   *
   * I could have added a parameter in the constructor to pass the login or id of the bot
   * but I preferred to keep things simple and prevent problems due to bad configuration.

   * My second idea was to add always a special label but in octokit the issue is created
   * first without labels and then labels are added, so I was not being able to ignore
   * the "opened" event.
   *
   * Finally I'm just checking the issue title
   * @param {*} context
   */
  didIDoIt (context) {
    const { issue } = context.payload
    return issue && issue.title.endsWith(this.title) && issue.title.match(/^\[[a-f0-9]{8}\]/)
  }

  /**
   * Core functionality for handling an error
   * @param {*} context
   * @param {*} err
   */
  async handleError (context, err) {
    const params = context.repo()
    const {owner, repo} = params

    const errString = this.errorToString(err)
    const errCode = this.hash(errString)

    // Look for an existing issue with the same error hash/code
    const q = [
      'sort:updated-desc',
      this.reopen ? '' : 'is:open',
      errCode
    ]
    .filter(Boolean)
    .join(' ')
    const result = await context.github.search.issues({ q })
    const issue = result.data.items[0]

    if (issue) {
      // If the issue exists we update the occurrences counter and also that updates
      // the updated_at date. Useful for sorting the issues in the UI or API
      const { number } = issue
      let { body } = issue
      body = body
        .replace(/(Occurrences:\s*)(\d+)/, (match, label, value) => label + String(+value + 1))
      // If reopen is set to true and the issue is closed, reopen it
      const state = issue.state === 'closed' && this.reopen ? 'open' : issue.state
      await context.github.issues.edit({ owner, repo, number, body, state })
    } else {
      const body = [
        this.body,
        '```\n' + errString + '\n```',
        'Occurrences: 1'
      ].join('\n\n')
      const title = `[${errCode}] ${this.title}`
      await context.github.issues.create({owner, repo, title, body, labels: this.labels})
    }
  }

  /**
   * Common functionality for invoking the original callback
   * @param {*} context
   * @param {*} callback
   * @param {*} context
   */
  async invokeCallback (context, callback, that) {
    try {
      if (this.didIDoIt(context)) return
      return await callback.apply(that, arguments)
    } catch (err) {
      await this.handleError(context, err)
      // Throw it again so it is handled by probot and logs it with bunyan
      throw err
    }
  }

  /**
   * Use this mehtod to wrap the whole bot application. It overrides the
   * robot.on() method to make sure all the event handlers are safely wrapped
   * to catch any errors.
   *
   * This is implemented in a way that "this" is kept even after wrapping the handler.
   *
   * All the probot examples use arrow functions, but if you pass
   * a regular function binded to an object and you invoke the function
   * then the "this" reference is kept. The same should happen in our
   * library, the ABI should not change when using probot-lifeguard
   * @param {*} handler
   */
  guardApp (handler) {
    const self = this
    return app => {
      const original = app.on.bind(app)
      app.on = function (event, callback) {
        return original(event, async function (context) {
          return self.invokeCallback(context, callback, this)
        })
      }
      handler(app)
    }
  }

  /**
   * Use this method to wrap just one event handler
   * @param {*} callback
   */
  guardHandler (callback) {
    const self = this
    return async function (context) {
      return self.invokeCallback(context, callback, this)
    }
  }
}

/**
 * Export a factory function. Many people don't like OOP/ES classes
 * @param {*} options
 */
module.exports = (options) => new Lifeguard(options)
