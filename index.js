const Alexa = require('alexa-sdk');
const request = require('request-promise-native');
const moment = require('moment');

exports.handler = function (event, context, callback) {
    const alexa = Alexa.handler(event, context);
    alexa.appId = process.env.ALEXA_APP_ID;
    alexa.registerHandlers(handlers);
    alexa.execute();
};

const handlers = {
    'LaunchRequest': launchRequestHandler,
    'AMAZON.StopIntent': stopIntentHandler,
    'AMAZON.CancelIntent': cancelIntentHandler,
    'AMAZON.HelpIntent': helpIntentHandler,
    'SlackClearStatusIntent': clearStatusIntentHandler,
    'SlackStatusIntent': statusIntentHandler,
    'Unhandled': unhandledIntentHandler,
};

/**
 * Handles launch requests, i.e. "Alexa, open [app name]".
 */
function launchRequestHandler() {
    let access_token = this.event.session.user.accessToken;
    if (access_token) {
        this.emit(':ask', 'What would you like to do?', "I'm sorry, I didn't hear you. Could you say that again?");
    } else {
        this.emit(':tellWithLinkAccountCard', 'Please connect your Slack account to Alexa using the Alexa app on your phone.');
    }
}


/**
 * Handles an `SlackClearStatusIntent`, which should clear the user's status
 * and snooze setting.
 */
function clearStatusIntentHandler() {
    let access_token = this.event.session.user.accessToken;
    let status = {
        status_text: '',
        status_emoji: ''
    };

    if (!access_token) {
        this.emit(':tellWithLinkAccountCard', 'Please connect your Slack account to Alexa using the Alexa app on your phone.');
    }

    setSlackStatus(status, access_token).then(() => {
        return isSnoozeOff(access_token);
    }).then(snooze_active => {
        if (snooze_active) {
            return timesUpSlack(access_token);
        }
    }).then(() => {
        this.emit(':tell', "Okay, I'll clear your status.");
    }).catch(error => {
        this.emit(':tell', error.message);
    });
}

/**
 * Handles slack status intent, setting profile and snoozing notifications
 */
function statusIntentHandler() {

    try {
        let consentTokenTest = this.event.context.System.user.permissions.consentToken;
        let deviceIdTest = this.event.context.System.device.deviceId;

        if (!consentTokenTest || !deviceIdTest) {
            throw("User did not give us permissions to access their address.");
        }

        console.log(JSON.stringify(this.event));

    } catch (e) {

        console.log(JSON.stringify(this.event));
        console.error(e);
        console.info("Ending getAddressHandler()");
        return;
    }

    let device_id = this.event.context.System.device.deviceId;
    let consent_token = this.event.context.System.user.permissions.consentToken;
    let access_token = this.event.session.user.accessToken;

    let status = this.event.request.intent.slots.status.value;
    let requested_time = this.event.request.intent.slots.time.value;

    if (!access_token) {
        this.emit(':tellWithLinkAccountCard', 'Please connect your Slack account to Alexa using the Alexa app on your phone.');
    }

    if (!status) {
        this.emit(':ask', "I didn't get your status, please try again.", "I'm sorry, I didn't hear you. Could you say that again?");
    }

    if (!requested_time) {
        this.emit(':ask', "I didn't get the time, please try again.", "I'm sorry, I didn't hear you. Could you say that again?");
    }

    requested_time = normalizeAmazonTime(requested_time);

    getEchoOffset(device_id, consent_token).then(offset => {
        return snoozeSlackUntil(requested_time, offset, access_token);
    }).then(() => {
        let slack_status = emojifyStatus(status);
        slack_status.status_text += ` until ${moment(requested_time, 'HH:mm').format('h:mm a')}`;
        return setSlackStatus(slack_status, access_token);
    }).then(() => {
        this.emit(':tell', `Okay, I'll change your status and snooze your notifications until 
        ${moment(requested_time, 'HH:mm').format('h:mm a')}.`);
    }).catch(error => {
        this.emit(':tell', error.message);
    });
}

/**
 * Built in intent response, stop
 */
function stopIntentHandler() {
    this.emit(':tell', "Okay");
}

/**
 * Built in intent response, cancel
 */
function cancelIntentHandler() {
    this.emit(':tell', "Okay");
}

/**
 * Built in intent response, help
 */
function helpIntentHandler() {
    let text = "<p>Here are a few things you can do:</p>";
    text += `<p>To set your status and snooze your notifications, say: I'm in status until time, for example: I'm grabbing coffee until 5:00 pm.</p>`;
    text += "<p>To clear your status, say: clear my status.</p>";
    console.log(Object);
    this.emit(":ask", text, "I'm sorry, I didn't hear you. Could you say that again?");
}

function unhandledIntentHandler() {
    this.emit(':ask', "I didn't get that. What would you like to do?", "I'm sorry, I didn't hear you. Could you say that again?");
}

/**
 * Sets slack user snooze until time
 * @param time
 * The time given by the user
 * @param offset
 * The offset
 * @param token
 * The auth token from slack
 * @returns {Promise}
 */
function snoozeSlackUntil(time, offset, token) {
    let minutes = getMinutesBetween(time, offset);
    return setSlackSnooze(minutes, token);
}

/**
 * Sets slack snooze for X minutes
 * @param minutes
 * The number of minutes we're snoozing for
 * @param token
 * The slack auth token
 * @returns {PromiseLike<T> | Promise<T>}
 */
function setSlackSnooze(minutes, token) {
    let opts = {
        method: 'POST',
        url: `https://slack.com/api/dnd.setSnooze`,
        form: {
            num_minutes: minutes,
            token: token
        },
        json: true,
        simple: false,
        resolveWithFullResponse: true
    };
    return request(opts).then(response => {
        if (response.statusCode !== 200 || !response.body.ok) {
            console.error(`Error setting Slack snooze: ${response}`);
            return Promise.reject(new Error("I couldn't snooze your Slack notifications."));
        }
    });
}

/**
 * Check if snooze is active
 * @param token
 * The slack auth token.
 * @returns {PromiseLike<T> | Promise<T>}
 */
function isSnoozeOff(token) {
    let opts = {
        method: 'POST',
        url: `https://slack.com/api/dnd.info`,
        form: {
            token: token
        },
        json: true,
        simple: false,
        resolveWithFullResponse: true
    };
    return request(opts).then(response => {
        if (response.statusCode === 200 && response.body.ok) {
            return response.body.snooze_enabled;
        } else {
            console.error(`Error checking Slack snooze status: ${response.body}`);
            return Promise.reject(new Error("I couldn't check your Slack snooze."));
        }
    });
}

/**
 * Ends the Slack user's snooze.
 * @param {String} token Slack auth token.
 * @return {Promise} A promise that resolves if the request is successful;
 * or is rejected with an error if it fails.
 */
function timesUpSlack(token) {
    let opts = {
        method: 'POST',
        url: `https://slack.com/api/dnd.endSnooze`,
        form: {
            token: token
        },
        json: true,
        simple: false,
        resolveWithFullResponse: true
    };
    return request(opts).then(response => {
        if (response.statusCode !== 200 || !response.body.ok) {
            console.error(`Error ending Slack snooze: ${response.body}`);
            return Promise.reject(new Error("I couldn't end your Slack snooze."));
        }
    });
}

/**
 * Set status for slack user
 * @param status
 * The status
 * @param token
 * Auth token from Slack app
 * @returns {PromiseLike<T> | Promise<T>}
 */
function setSlackStatus(status, token) {
    let opts = {
        method: 'POST',
        url: `https://slack.com/api/users.profile.set`,
        form: {
            profile: JSON.stringify(status),
            token: token
        },
        json: true,
        simple: false,
        resolveWithFullResponse: true
    };
    return request(opts).then(response => {
        if (response.statusCode !== 200 || !response.body.ok) {
            console.error(`Error setting Slack status: ${response.body}`);
            return Promise.reject(new Error("I couldn't set your Slack status."));
        }
    });
}

/**
 * Normalizes amazon time in case terms like "afternoon" or "morning" were used
 * @param time
 * The time from Amazon.Time type
 * @returns {*}
 */
function normalizeAmazonTime(time) {
    switch (time) {
        case 'MO':
            time = '09:00';
            break;
        case 'AF':
            time = '13:00';
            break;
        case 'EV':
            time = '19:00';
            break;
        case 'NI':
            time = '21:00';
            break;
    }
    return time;
}

/**
 * Calculate # of minutes we want to snooze for difference of now and requested time.
 * @param requested_time
 * The time we're snoozing until
 * @param offset
 * The offset
 * @returns {number}
 * number of minutes
 */
function getMinutesBetween(requested_time, offset) {

    requested_time = moment(`${requested_time}Z`, 'HH:mmZ');

    console.log(`moment as UTC: ${requested_time}`);

    requested_time = requested_time.utcOffset(offset, true);

    let now = moment(Date.now()).utcOffset(offset);

    if(now.isAfter(requested_time)){
        requested_time.add(1, 'day');
    }

    let diff = requested_time.diff(now, 'minutes');

    if(diff > 1440){
        diff = diff - 1440;
    }

    console.log(`DIFF: ${diff}`);
    return diff;
}

/**
 * Get Echo offset based on address
 * @param device_id
 * The id of the echo
 * @param consent_token
 * The token that represents user granting permission
 * @returns {PromiseLike<T>}
 */
function getEchoOffset(device_id, consent_token) {
    return getEchoAddress(device_id, consent_token).then(getGeocodeForLocation).then(getOffset);
}

/**
 * Gets the country and postal code from Alexa API needed for Geocode.
 * @param device_id
 * The ID of the echo
 * @param consent_token
 * The token that represents user granting permission
 * @returns {PromiseLike<T> | Promise<T>}
 */
function getEchoAddress(device_id, consent_token) {
    let opts = {
        url: `https://api.amazonalexa.com/v1/devices/${device_id}/settings/address/countryAndPostalCode`,
        headers: {
            'Authorization': `Bearer ${consent_token}`
        },
        json: true,
        simple: false,
        resolveWithFullResponse: true
    };
    return request(opts).then(response => {
        if (response.statusCode === 200) {
            return `${response.body.postalCode} ${response.body.countryCode}`;
        } else {
            console.log(response.body);
            console.log(response.body.postalCode);

            console.error(`Error getting Echo address: ${response.statusCode} ${response.body}`);
            return Promise.reject(new Error("I'm sorry, I couldn't get your location. " +
                "Make sure you've given this skill permission to use your address in the Alexa app."));
        }
    });
}


/**
 * Gets the GeoCode for the location from the Google Maps API
 * @param location
 * The location
 * @returns {PromiseLike<T> | Promise<T>}
 * The geocode from the response
 */
function getGeocodeForLocation(location) {
    let opts = {
        url: `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(location)}&key=${process.env.MAPS_API_KEY}`,
        json: true,
        simple: false,
        resolveWithFullResponse: true
    };
    return request(opts).then(response => {
        if ((response.statusCode === 200) && (response.body.status === 'OK')) {
            return response.body.results[0];
        } else {
            console.error(`Error geocoding location: ${response.body.status}`);
            return Promise.reject(new Error("I'm sorry, I couldn't understand that address."));
        }
    });
}

/**
 * Gets time zone for location
 * @param location
 * @returns {PromiseLike<T> | Promise<T>}
 */
function getOffset(location) {
    let opts = {
        url: `https://maps.googleapis.com/maps/api/timezone/json?location=${location.geometry.location.lat},${location.geometry.location.lng}&timestamp=${Math.round(Date.now() / 1000)}&key=${process.env.MAPS_API_KEY}`,
        json: true,
        simple: false,
        resolveWithFullResponse: true
    };
    return request(opts).then(response => {
        if ((response.statusCode === 200) && (response.body.status === 'OK')) {
            return (response.body.rawOffset + response.body.dstOffset) / 60;
        } else {
            console.error(`Error determining UTC offset: ${response.body.status}`);
            return Promise.reject(new Error("I'm sorry, I couldn't get the timezone for that location."));
        }
    });
}

/**
 * Creates the profile object that is used by the slack API
 * and emojis!
 * @param status
 * The user requested status
 */
function emojifyStatus(status) {
    if (status.match(/lunch/)) {
        profile = {
            status_text: 'Out for lunch',
            status_emoji: ':taco:'
        };
    } else if (status.match(/coffee/)) {
        profile = {
            status_text: 'Out for coffee',
            status_emoji: ':coffee:'
        };
    } else if (status.match(/busy|unavailable|head down|DND|do not disturb/)) {
        profile = {
            status_text: 'Do not disturb',
            status_emoji: ':no_entry_sign:'
        };
    } else if (status.match(/errand/)) {
        profile = {
            status_text: 'Running an errand',
            status_emoji: ':running:'
        };
    } else if (status.match(/doctor/)) {
        profile = {
            status_text: 'Doctor\'s appointment',
            status_emoji: ':face_with_thermometer:'
        };
    } else if (status.match(/away|AFK/)) {
        profile = {
            status_text: 'AFK',
            status_emoji: ':zzz:'
        };
    } else if (status.match(/call/)) {
        profile = {
            status_text: 'On a call',
            status_emoji: ':phone:'
        };
    } else if (status.match(/meeting/)) {
        profile = {
            status_text: 'In a meeting',
            status_emoji: ':calendar:'
        };
    } else if (status.match(/sick/)) {
        profile = {
            status_text: 'Out sick',
            status_emoji: ':face_with_thermometer:'
        };
    } else if (status.match(/commuting/)) {
        profile = {
            status_text: 'Commuting',
            status_emoji: ':bus:'
        };
    } else if (status.match(/vacation/)) {
        profile = {
            status_text: 'On vacation',
            status_emoji: ':palm_tree:'
        };
    } else {
        profile = {
            status_text: status,
            status_emoji: ':mute:'
        };
    }
    return profile;
}
