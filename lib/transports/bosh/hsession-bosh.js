/*
 * Copyright (c) Novedia Group 2012.
 *
 *     This file is part of Hubiquitus.
 *
 *     Hubiquitus is free software: you can redistribute it and/or modify
 *     it under the terms of the GNU General Public License as published by
 *     the Free Software Foundation, either version 3 of the License, or
 *     (at your option) any later version.
 *
 *     Hubiquitus is distributed in the hope that it will be useful,
 *     but WITHOUT ANY WARRANTY; without even the implied warranty of
 *     MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *     GNU General Public License for more details.
 *
 *     You should have received a copy of the GNU General Public License
 *     along with Hubiquitus.  If not, see <http://www.gnu.org/licenses/>.
 */
//Make it compatible with node and web browser
if (typeof define !== 'function') {
    var define = require('amdefine')(module);
    var sessionStorage = require('../../sessionStorage.js');
}

define(
    ['./strophe.pubsub', '../../codes'],
    function(Strophe, codes){

        //Load correct modules if running on Node
        if(typeof module !== 'undefined' && module.exports){
            $iq     = Strophe.$iq;
            $pres   = Strophe.$pres;
        }

        var Strophe = Strophe.Strophe;
        var errors = codes.errors;
        var statuses = codes.statuses;

        //If a connection fails. This sets the timeouts for retrying. Used from right to left, in seconds.
        var retryTimeouts = [600, 300, 60, 30, 10, 2];


        // Constructor
        var hSessionBosh = function(opts, onMessage) {
            this.options = opts;
            this.callback = onMessage;
            this.pubsub =  "pubsub." + (this.options.domain || this.options.username.split('@')[1]);
            this.retryTimeouts = retryTimeouts;
            this.ridInterval = 10; //Interval to save RID to persistent storage, in seconds.

            //Create a Strophe connection
            this.conn = new Strophe.Connection(this.options.gateway.bosh.endpoint);
        }

        hSessionBosh.prototype = {

            /**
             * Tries to recover and reattach and old connection or connect to a new one.
             * @param force (boolean, optional). If defined and true. A reattach won't be tried and
             * a new connection will be started.
             */
            connect: function(force) {
                //If there is a saved session, try to use it
                if(!force && typeof sessionStorage.getItem('jid') === 'string'){
                    console.log('Reattaching');
                    //Our request must be a new one
                    var rid = parseInt(sessionStorage.getItem('rid'))+1;
                    this.conn.attach(
                        sessionStorage.getItem('jid'),
                        sessionStorage.getItem('sid'),
                        sessionStorage.getItem('rid'),
                        this.onStatus.bind(this),
                        null, null, null)
                } else{
                    //We don't have enough information to restablish the connection. Establish a new one
                    console.log('Starting New Connection');
                    this.conn.connect(
                        this.options.username,
                        this.options.password,
                        this.onStatus.bind(this),
                        null, null, null
                    );
                }
            },

            //Callback for the connection status.
            //When connected, send presence to the server and set the callback to retrieve stanzas
            onStatus: function(status)
            {
                var errorCode;
                var statusCode;
                var self = this;

                function _onConnection(){
                    //Send Presence
                    self.conn.send($pres());

                    //Add Handlers
                    self.conn.addHandler(self.handleIQ.bind(self), null, 'iq', 'get',null, null, {matchBare: true});
                    self.conn.addHandler(self.handleMessage.bind(self), Strophe.NS.PUBSUB_EVENT,'message',
                        null, null, self.pubsub, {matchBare: true});

                    //Save SID and JID
                    sessionStorage.setItem('jid', self.conn.jid);
                    sessionStorage.setItem('sid', self.conn.sid);

                    //Set a timer to save RID every X seconds
                    self.ridSaver = setInterval(function(){
                        console.log('Saved Data ' + self.conn.rid);
                        sessionStorage.setItem('rid', self.conn.rid);
                    },self.ridInterval*1000);

                    self.retryTimeouts = retryTimeouts; //Resets the reconnection counter
                }
                function _onError(){
                    sessionStorage.removeItem('jid');
                    sessionStorage.removeItem('sid');
                    sessionStorage.removeItem('rid');
                    clearInterval(self.ridSaver);

                    var timeout = self.retryTimeouts.length == 1 ? self.retryTimeouts[0] : self.retryTimeouts.pop();
                    setTimeout(self.connect.bind(self, true),timeout*1000);
                }

                switch(status){
                    case Strophe.Status.CONNECTED:
                        statusCode = statuses.Connected;
                    case Strophe.Status.ATTACHED:
                        statusCode = statusCode || statuses.Attached;
                        _onConnection();
                        break;
                    case Strophe.Status.CONNFAIL:
                        errorCode = errors.CONNECTION_FAILED;
                    case Strophe.Status.ERROR:
                        errorCode = errorCode || errors.UNKNOWN_ERROR;
                        statusCode = statuses.Error;
                        _onError();
                        break;
                    case Strophe.Status.CONNECTING:
                        statusCode = statuses.Connecting;
                        break;
                    case Strophe.Status.DISCONNECTING:
                        statusCode = statuses.Disconnecting;
                        break;
                    case Strophe.Status.DISCONNECTED:
                        statusCode = statuses.Disconnected;
                        break;
                    case Strophe.Status.AUTHFAIL:
                        statusCode = statuses.Error;
                        errorCode = errors.AUTH_FAILED;
                        break;
                }
                if(statusCode)
                    this.callback({context: 'link', data: {status: statusCode, code: errorCode}});
            },

            //Handle to retrieve items
            handleMessage: function(stanza) {

                var parsedItems = [];
                var _data = stanza.getElementsByTagName('items')[0];
                var _channel = _data.getAttribute('node');

                var items = _data.getElementsByTagName('item');
                for(var i = 0; i < items.length; i++)
                    parsedItems.push(items[i].childNodes[0].childNodes[0].nodeValue);

                //Calling client callback with the extracted message
                for(var i in parsedItems)
                    this.callback({context: 'message', data :
                    {channel: _channel, message: parsedItems[i]}})
                return true;
            },

            //In case we receive an iq-get request, send an error cause we don't allow them
            handleIQ : function(stanza){
                var msg = $iq({
                    to: stanza.attributes.from.nodeValue,
                    type: 'error',
                    id: stanza.attributes.id.nodeValue
                })
                    .c(stanza.firstChild.nodeName, {xmlns: stanza.firstChild.attributes.xmlns.nodeValue}).up()
                    .c('error', { type: 'cancel'})
                    .c('service-unavailable', {xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas'});

                console.log("Received an IQ from the server. Responding.");
                this.conn.send(msg);
                return true; //If it doesn't return true, Strophe will remove it from Handler's list
            },

            disconnect: function() {
                this.conn.flush();
                this.conn.disconnect();
            },

            subscribe: function(channel){
                /*
                 Done in two phases:
                 1. Ask for subscriptions and check if there are others to the same node
                 2. If there aren't, request a new one
                 */
                function _success(stanza){
                    this.callback({context: 'result', data:
                    {type: 'subscribe', channel: channel, msgid: msgId}});
                }

                function _failure(stanza, errorCode){
                    this.callback({context: 'error', data:
                    {type: 'subscribe', code: errorCode, channel: channel, msgid: msgId}});
                }

                function _callbackSubscriptions(stanza){
                    var subs = stanza.getElementsByTagName('subscriptions')[0].childNodes;
                    var i = 0;
                    while(i < subs.length && subs[i].getAttribute('node') != channel)
                        i++;

                    if(!subs[i] || subs[i].getAttribute('node') != channel){
                        //Not Subscribed
                        this.conn.pubsub.subscribe(
                            channel,
                            undefined,
                            undefined,
                            _success.bind(this),
                            _failure.bind(this));
                    } else{
                        //Already subscribed
                        _failure.call(this,stanza, errors.ALREADY_SUBSCRIBED);
                    }
                }

                var msgId = this.conn.pubsub.getSubscriptions(_callbackSubscriptions.bind(this));
                return msgId;
            },

            unsubscribe : function(channel){
                function _success(stanza){
                    console.log('here1');
                    this.callback({context: 'result', data:
                    {type: 'unsubscribe', channel: channel, msgid: stanza.getAttribute('id')}});
                }

                function _failure(stanza){
                    this.callback({context: 'error', data:
                    {type: 'unsubscribe', channel: channel, msgid: stanza.getAttribute('id')}});
                }

                return this.conn.pubsub.unsubscribe(
                    channel,
                    undefined,
                    undefined,
                    _success.bind(this),
                    _failure.bind(this));
            },

            publish : function(channel,item){
                function _callback(stanza){
                    if(stanza.getAttribute('type') == 'error')
                        this.callback({context: 'error', data:
                        {type: 'publish', channel: channel, msgid: stanza.getAttribute('id')}});
                    else
                        this.callback({context: 'result', data:
                        {type: 'publish', channel: channel, msgid: stanza.getAttribute('id')}});
                }

                return this.conn.pubsub.publish(
                    channel,
                    [{data: item}],
                    _callback.bind(this));
            },

            getMessages : function(channel){
                function _failure(stanza){
                    this.callback({context: 'error', data:
                    {type: 'get_messages', channel: channel, msgid: stanza.getAttribute('id')}});
                }
                return this.conn.pubsub.items(channel,
                    this.handleMessage.bind(this), _failure.bind(this));
            }
        }

        //requireJS way to import
        return{
            hSessionBosh : hSessionBosh
        }
    }
);