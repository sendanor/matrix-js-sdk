/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2017 New Vector Ltd
Copyright 2019, 2020 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

/**
 * This is an internal module. See {@link createNewMatrixCall} for the public API.
 * @module webrtc/call
 */

import { logger } from '../logger';
import { EventEmitter } from 'events';
import { checkObjectHasKeys, recursivelyAssign } from '../utils';
import { MatrixEvent } from '../models/event';
import { EventType } from '../@types/event';
import { RoomMember } from '../models/room-member';
import { randomString } from '../randomstring';
import {
    MCallReplacesEvent,
    MCallAnswer,
    MCallOfferNegotiate,
    CallCapabilities,
    SDPStreamMetadataPurpose,
    SDPStreamMetadata,
    SDPStreamMetadataKey,
    MCallSDPStreamMetadataChanged,
} from './callEventTypes';
import { CallFeed } from './callFeed';

// events: hangup, error(err), replaced(call), state(state, oldState)

/**
 * Fires whenever an error occurs when call.js encounters an issue with setting up the call.
 * <p>
 * The error given will have a code equal to either `MatrixCall.ERR_LOCAL_OFFER_FAILED` or
 * `MatrixCall.ERR_NO_USER_MEDIA`. `ERR_LOCAL_OFFER_FAILED` is emitted when the local client
 * fails to create an offer. `ERR_NO_USER_MEDIA` is emitted when the user has denied access
 * to their audio/video hardware.
 *
 * @event module:webrtc/call~MatrixCall#"error"
 * @param {Error} err The error raised by MatrixCall.
 * @example
 * matrixCall.on("error", function(err){
 *   console.error(err.code, err);
 * });
 */

interface CallOpts {
    roomId?: string;
    client?: any; // Fix when client is TSified
    forceTURN?: boolean;
    turnServers?: Array<TurnServer>;
}

interface TurnServer {
    urls: Array<string>;
    username?: string;
    password?: string;
    ttl?: number;
}

interface AssertedIdentity {
    id: string;
    displayName: string;
}

export enum CallState {
    Fledgling = 'fledgling',
    InviteSent = 'invite_sent',
    WaitLocalMedia = 'wait_local_media',
    CreateOffer = 'create_offer',
    CreateAnswer = 'create_answer',
    Connecting = 'connecting',
    Connected = 'connected',
    Ringing = 'ringing',
    Ended = 'ended',
}

export enum CallType {
    Voice = 'voice',
    Video = 'video',
}

export enum CallDirection {
    Inbound = 'inbound',
    Outbound = 'outbound',
}

export enum CallParty {
    Local = 'local',
    Remote = 'remote',
}

export enum CallEvent {
    Hangup = 'hangup',
    State = 'state',
    Error = 'error',
    Replaced = 'replaced',

    // The value of isLocalOnHold() has changed
    LocalHoldUnhold = 'local_hold_unhold',
    // The value of isRemoteOnHold() has changed
    RemoteHoldUnhold = 'remote_hold_unhold',
    // backwards compat alias for LocalHoldUnhold: remove in a major version bump
    HoldUnhold = 'hold_unhold',
    // Feeds have changed
    FeedsChanged = 'feeds_changed',

    AssertedIdentityChanged = 'asserted_identity_changed',
}

export enum CallErrorCode {
    /** The user chose to end the call */
    UserHangup = 'user_hangup',

    /** An error code when the local client failed to create an offer. */
    LocalOfferFailed = 'local_offer_failed',
    /**
     * An error code when there is no local mic/camera to use. This may be because
     * the hardware isn't plugged in, or the user has explicitly denied access.
     */
    NoUserMedia = 'no_user_media',

    /**
     * Error code used when a call event failed to send
     * because unknown devices were present in the room
     */
    UnknownDevices = 'unknown_devices',

    /**
     * Error code used when we fail to send the invite
     * for some reason other than there being unknown devices
     */
    SendInvite = 'send_invite',

    /**
     * An answer could not be created
     */
    CreateAnswer = 'create_answer',

    /**
     * Error code used when we fail to send the answer
     * for some reason other than there being unknown devices
     */
    SendAnswer = 'send_answer',

    /**
     * The session description from the other side could not be set
     */
    SetRemoteDescription = 'set_remote_description',

    /**
     * The session description from this side could not be set
     */
    SetLocalDescription = 'set_local_description',

    /**
     * A different device answered the call
     */
    AnsweredElsewhere = 'answered_elsewhere',

    /**
     * No media connection could be established to the other party
     */
    IceFailed = 'ice_failed',

    /**
     * The invite timed out whilst waiting for an answer
     */
    InviteTimeout = 'invite_timeout',

    /**
     * The call was replaced by another call
     */
    Replaced = 'replaced',

    /**
     * Signalling for the call could not be sent (other than the initial invite)
     */
    SignallingFailed = 'signalling_timeout',

    /**
     * The remote party is busy
     */
    UserBusy = 'user_busy',

    /**
     * We transferred the call off to somewhere else
     */
    Transfered = 'transferred',
}

enum ConstraintsType {
    Audio = "audio",
    Video = "video",
}

/**
 * The version field that we set in m.call.* events
 */
const VOIP_PROTO_VERSION = 1;

/** The fallback ICE server to use for STUN or TURN protocols. */
const FALLBACK_ICE_SERVER = 'stun:turn.matrix.org';

/** The length of time a call can be ringing for. */
const CALL_TIMEOUT_MS = 60000;

/** Retrieves sources from desktopCapturer */
export function getDesktopCapturerSources(): Promise<Array<DesktopCapturerSource>> {
    const options: GetSourcesOptions = {
        thumbnailSize: {
            height: 176,
            width: 312,
        },
        types: [
            "screen",
            "window",
        ],
    };
    return window.electron.getDesktopCapturerSources(options);
}

export class CallError extends Error {
    code: string;

    constructor(code: CallErrorCode, msg: string, err: Error) {
        // Still don't think there's any way to have proper nested errors
        super(msg + ": " + err);

        this.code = code;
    }
}

function genCallID(): string {
    return Date.now().toString() + randomString(16);
}

/**
 * Construct a new Matrix Call.
 * @constructor
 * @param {Object} opts Config options.
 * @param {string} opts.roomId The room ID for this call.
 * @param {Object} opts.webRtc The WebRTC globals from the browser.
 * @param {boolean} opts.forceTURN whether relay through TURN should be forced.
 * @param {Object} opts.URL The URL global.
 * @param {Array<Object>} opts.turnServers Optional. A list of TURN servers.
 * @param {MatrixClient} opts.client The Matrix Client instance to send events to.
 */
export class MatrixCall extends EventEmitter {
    roomId: string;
    type: CallType;
    callId: string;
    state: CallState;
    hangupParty: CallParty;
    hangupReason: string;
    direction: CallDirection;
    ourPartyId: string;

    private client: any; // Fix when client is TSified
    private forceTURN: boolean;
    private turnServers: Array<TurnServer>;
    private candidateSendQueue: Array<RTCIceCandidate>;
    private candidateSendTries: number;
    private sentEndOfCandidates: boolean;
    private peerConn: RTCPeerConnection;
    private feeds: Array<CallFeed>;
    private usermediaSenders: Array<RTCRtpSender>;
    private screensharingSenders: Array<RTCRtpSender>;
    private inviteOrAnswerSent: boolean;
    private waitForLocalAVStream: boolean;
    private successor: MatrixCall;
    private opponentMember: RoomMember;
    private opponentVersion: number;
    // The party ID of the other side: undefined if we haven't chosen a partner
    // yet, null if we have but they didn't send a party ID.
    private opponentPartyId: string;
    private opponentCaps: CallCapabilities;
    private inviteTimeout: number;

    // The logic of when & if a call is on hold is nontrivial and explained in is*OnHold
    // This flag represents whether we want the other party to be on hold
    private remoteOnHold;

    // the stats for the call at the point it ended. We can't get these after we
    // tear the call down, so we just grab a snapshot before we stop the call.
    // The typescript definitions have this type as 'any' :(
    private callStatsAtEnd: any[];

    // Perfect negotiation state: https://www.w3.org/TR/webrtc/#perfect-negotiation-example
    private makingOffer: boolean;
    private ignoreOffer: boolean;

    // If candidates arrive before we've picked an opponent (which, in particular,
    // will happen if the opponent sends candidates eagerly before the user answers
    // the call) we buffer them up here so we can then add the ones from the party we pick
    private remoteCandidateBuffer = new Map<string, RTCIceCandidate[]>();

    private remoteAssertedIdentity: AssertedIdentity;

    private remoteSDPStreamMetadata: SDPStreamMetadata;

    constructor(opts: CallOpts) {
        super();
        this.roomId = opts.roomId;
        this.client = opts.client;
        this.type = null;
        this.forceTURN = opts.forceTURN;
        this.ourPartyId = this.client.deviceId;
        // Array of Objects with urls, username, credential keys
        this.turnServers = opts.turnServers || [];
        if (this.turnServers.length === 0 && this.client.isFallbackICEServerAllowed()) {
            this.turnServers.push({
                urls: [FALLBACK_ICE_SERVER],
            });
        }
        for (const server of this.turnServers) {
            checkObjectHasKeys(server, ["urls"]);
        }

        this.callId = genCallID();
        this.state = CallState.Fledgling;

        // A queue for candidates waiting to go out.
        // We try to amalgamate candidates into a single candidate message where
        // possible
        this.candidateSendQueue = [];
        this.candidateSendTries = 0;

        this.sentEndOfCandidates = false;
        this.inviteOrAnswerSent = false;
        this.makingOffer = false;

        this.remoteOnHold = false;

        this.feeds = [];

        this.usermediaSenders = [];
        this.screensharingSenders = [];
    }

    /**
     * Place a voice call to this room.
     * @throws If you have not specified a listener for 'error' events.
     */
    async placeVoiceCall() {
        logger.debug("placeVoiceCall");
        this.checkForErrorListener();
        const constraints = getUserMediaContraints(ConstraintsType.Audio);
        this.type = CallType.Voice;
        await this.placeCallWithConstraints(constraints);
    }

    /**
     * Place a video call to this room.
     * @throws If you have not specified a listener for 'error' events.
     */
    async placeVideoCall() {
        logger.debug("placeVideoCall");
        this.checkForErrorListener();
        const constraints = getUserMediaContraints(ConstraintsType.Video);
        this.type = CallType.Video;
        await this.placeCallWithConstraints(constraints);
    }

    public getOpponentMember() {
        return this.opponentMember;
    }

    public opponentCanBeTransferred() {
        return Boolean(this.opponentCaps && this.opponentCaps["m.call.transferee"]);
    }

    public opponentSupportsDTMF(): boolean {
        return Boolean(this.opponentCaps && this.opponentCaps["m.call.dtmf"]);
    }

    public getRemoteAssertedIdentity(): AssertedIdentity {
        return this.remoteAssertedIdentity;
    }

    public get localUsermediaFeed(): CallFeed {
        return this.getLocalFeeds().find((feed) => feed.purpose === SDPStreamMetadataPurpose.Usermedia);
    }

    public get localScreensharingFeed(): CallFeed {
        return this.getLocalFeeds().find((feed) => feed.purpose === SDPStreamMetadataPurpose.Screenshare);
    }

    public get localUsermediaStream(): MediaStream {
        return this.localUsermediaFeed?.stream;
    }

    private get localScreensharingStream(): MediaStream {
        return this.localScreensharingFeed?.stream;
    }

    private getFeedByStreamId(streamId: string): CallFeed {
        return this.getFeeds().find((feed) => feed.stream.id === streamId);
    }

    /**
     * Returns an array of all CallFeeds
     * @returns {Array<CallFeed>} CallFeeds
     */
    public getFeeds(): Array<CallFeed> {
        return this.feeds;
    }

    /**
     * Returns an array of all local CallFeeds
     * @returns {Array<CallFeed>} local CallFeeds
     */
    public getLocalFeeds(): Array<CallFeed> {
        return this.feeds.filter((feed) => feed.isLocal());
    }

    /**
     * Returns an array of all remote CallFeeds
     * @returns {Array<CallFeed>} remote CallFeeds
     */
    public getRemoteFeeds(): Array<CallFeed> {
        return this.feeds.filter((feed) => !feed.isLocal());
    }

    /**
     * Generates and returns localSDPStreamMetadata
     * @returns {SDPStreamMetadata} localSDPStreamMetadata
     */
    private getLocalSDPStreamMetadata(): SDPStreamMetadata {
        const metadata: SDPStreamMetadata = {};
        for (const localFeed of this.getLocalFeeds()) {
            metadata[localFeed.stream.id] = {
                purpose: localFeed.purpose,
                audio_muted: localFeed.isAudioMuted(),
                video_muted: localFeed.isVideoMuted(),
            };
        }
        logger.debug("Got local SDPStreamMetadata", metadata);
        return metadata;
    }

    /**
     * Returns true if there are no incoming feeds,
     * otherwise returns false
     * @returns {boolean} no incoming feeds
     */
    public noIncomingFeeds(): boolean {
        return !this.feeds.some((feed) => !feed.isLocal());
    }

    private pushRemoteFeed(stream: MediaStream) {
        // Fallback to old behavior if the other side doesn't support SDPStreamMetadata
        if (!this.opponentSupportsSDPStreamMetadata()) {
            this.pushRemoteFeedWithoutMetadata(stream);
            return;
        }

        const userId = this.getOpponentMember().userId;
        const purpose = this.remoteSDPStreamMetadata[stream.id].purpose;
        const audioMuted = this.remoteSDPStreamMetadata[stream.id].audio_muted;
        const videoMuted = this.remoteSDPStreamMetadata[stream.id].video_muted;

        if (!purpose) {
            logger.warn(`Ignoring stream with id ${stream.id} because we didn't get any metadata about it`);
            return;
        }

        // Try to find a feed with the same purpose as the new stream,
        // if we find it replace the old stream with the new one
        const existingFeed = this.getRemoteFeeds().find((feed) => feed.purpose === purpose);
        if (existingFeed) {
            existingFeed.setNewStream(stream);
        } else {
            this.feeds.push(new CallFeed(stream, userId, purpose, this.client, this.roomId, audioMuted, videoMuted));
            this.emit(CallEvent.FeedsChanged, this.feeds);
        }

        logger.info(`Pushed remote stream (id="${stream.id}", active="${stream.active}", purpose=${purpose})`);
    }

    /**
     * This method is used ONLY if the other client doesn't support sending SDPStreamMetadata
     */
    private pushRemoteFeedWithoutMetadata(stream: MediaStream) {
        const userId = this.getOpponentMember().userId;
        // We can guess the purpose here since the other client can only send one stream
        const purpose = SDPStreamMetadataPurpose.Usermedia;
        const oldRemoteStream = this.feeds.find((feed) => !feed.isLocal())?.stream;

        // Note that we check by ID and always set the remote stream: Chrome appears
        // to make new stream objects when transceiver directionality is changed and the 'active'
        // status of streams change - Dave
        // If we already have a stream, check this stream has the same id
        if (oldRemoteStream && stream.id !== oldRemoteStream.id) {
            logger.warn(`Ignoring new stream ID ${stream.id}: we already have stream ID ${oldRemoteStream.id}`);
            return;
        }

        // Try to find a feed with the same stream id as the new stream,
        // if we find it replace the old stream with the new one
        const feed = this.getFeedByStreamId(stream.id);
        if (feed) {
            feed.setNewStream(stream);
        } else {
            this.feeds.push(new CallFeed(stream, userId, purpose, this.client, this.roomId, false, false));
            this.emit(CallEvent.FeedsChanged, this.feeds);
        }

        logger.info(`Pushed remote stream (id="${stream.id}", active="${stream.active}")`);
    }

    private pushLocalFeed(stream: MediaStream, purpose: SDPStreamMetadataPurpose, addToPeerConnection = true) {
        const userId = this.client.getUserId();

        // We try to replace an existing feed if there already is one with the same purpose
        const existingFeed = this.getLocalFeeds().find((feed) => feed.purpose === purpose);
        if (existingFeed) {
            existingFeed.setNewStream(stream);
        } else {
            this.feeds.push(new CallFeed(stream, userId, purpose, this.client, this.roomId, false, false));
            this.emit(CallEvent.FeedsChanged, this.feeds);
        }

        // TODO: Find out what is going on here
        // why do we enable audio (and only audio) tracks here? -- matthew
        setTracksEnabled(stream.getAudioTracks(), true);

        if (addToPeerConnection) {
            const senderArray = purpose === SDPStreamMetadataPurpose.Usermedia ?
                this.usermediaSenders : this.screensharingSenders;
            // Empty the array
            senderArray.splice(0, senderArray.length);

            this.emit(CallEvent.FeedsChanged, this.feeds);
            for (const track of stream.getTracks()) {
                logger.info(
                    `Adding track (` +
                    `id="${track.id}", ` +
                    `kind="${track.kind}", ` +
                    `streamId="${stream.id}", ` +
                    `streamPurpose="${purpose}"` +
                    `) to peer connection`,
                );
                senderArray.push(this.peerConn.addTrack(track, stream));
            }
        }

        logger.info(`Pushed local stream (id="${stream.id}", active="${stream.active}", purpose="${purpose}")`);
    }

    private deleteAllFeeds() {
        this.feeds = [];
        this.emit(CallEvent.FeedsChanged, this.feeds);
    }

    private deleteFeedByStream(stream: MediaStream) {
        logger.debug(`Removing feed with stream id ${stream.id}`);

        const feed = this.getFeedByStreamId(stream.id);
        if (!feed) {
            logger.warn(`Didn't find the feed with stream id ${stream.id} to delete`);
            return;
        }

        this.feeds.splice(this.feeds.indexOf(feed), 1);
        this.emit(CallEvent.FeedsChanged, this.feeds);
    }

    // The typescript definitions have this type as 'any' :(
    public async getCurrentCallStats(): Promise<any[]> {
        if (this.callHasEnded()) {
            return this.callStatsAtEnd;
        }

        return this.collectCallStats();
    }

    private async collectCallStats(): Promise<any[]> {
        // This happens when the call fails before it starts.
        // For example when we fail to get capture sources
        if (!this.peerConn) return;

        const statsReport = await this.peerConn.getStats();
        const stats = [];
        for (const item of statsReport) {
            stats.push(item[1]);
        }

        return stats;
    }

    /**
     * Configure this call from an invite event. Used by MatrixClient.
     * @param {MatrixEvent} event The m.call.invite event
     */
    async initWithInvite(event: MatrixEvent) {
        const invite = event.getContent();
        this.direction = CallDirection.Inbound;

        // make sure we have valid turn creds. Unless something's gone wrong, it should
        // poll and keep the credentials valid so this should be instant.
        const haveTurnCreds = await this.client.checkTurnServers();
        if (!haveTurnCreds) {
            logger.warn("Failed to get TURN credentials! Proceeding with call anyway...");
        }

        const sdpStreamMetadata = invite[SDPStreamMetadataKey];
        if (sdpStreamMetadata) {
            this.updateRemoteSDPStreamMetadata(sdpStreamMetadata);
        } else {
            logger.debug("Did not get any SDPStreamMetadata! Can not send/receive multiple streams");
        }

        this.peerConn = this.createPeerConnection();
        // we must set the party ID before await-ing on anything: the call event
        // handler will start giving us more call events (eg. candidates) so if
        // we haven't set the party ID, we'll ignore them.
        this.chooseOpponent(event);
        try {
            await this.peerConn.setRemoteDescription(invite.offer);
            await this.addBufferedIceCandidates();
        } catch (e) {
            logger.debug("Failed to set remote description", e);
            this.terminate(CallParty.Local, CallErrorCode.SetRemoteDescription, false);
            return;
        }

        const remoteStream = this.feeds.find((feed) => !feed.isLocal())?.stream;

        // According to previous comments in this file, firefox at some point did not
        // add streams until media started arriving on them. Testing latest firefox
        // (81 at time of writing), this is no longer a problem, so let's do it the correct way.
        if (!remoteStream || remoteStream.getTracks().length === 0) {
            logger.error("No remote stream or no tracks after setting remote description!");
            this.terminate(CallParty.Local, CallErrorCode.SetRemoteDescription, false);
            return;
        }

        this.type = remoteStream.getTracks().some(t => t.kind === 'video') ? CallType.Video : CallType.Voice;

        this.setState(CallState.Ringing);

        if (event.getLocalAge()) {
            setTimeout(() => {
                if (this.state == CallState.Ringing) {
                    logger.debug("Call invite has expired. Hanging up.");
                    this.hangupParty = CallParty.Remote; // effectively
                    this.setState(CallState.Ended);
                    this.stopAllMedia();
                    if (this.peerConn.signalingState != 'closed') {
                        this.peerConn.close();
                    }
                    this.emit(CallEvent.Hangup);
                }
            }, invite.lifetime - event.getLocalAge());
        }
    }

    /**
     * Configure this call from a hangup or reject event. Used by MatrixClient.
     * @param {MatrixEvent} event The m.call.hangup event
     */
    initWithHangup(event: MatrixEvent) {
        // perverse as it may seem, sometimes we want to instantiate a call with a
        // hangup message (because when getting the state of the room on load, events
        // come in reverse order and we want to remember that a call has been hung up)
        this.setState(CallState.Ended);
    }

    /**
     * Answer a call.
     */
    async answer() {
        if (this.inviteOrAnswerSent) {
            return;
        }

        logger.debug(`Answering call ${this.callId} of type ${this.type}`);

        if (!this.localUsermediaStream && !this.waitForLocalAVStream) {
            const constraints = getUserMediaContraints(
                this.type == CallType.Video ?
                    ConstraintsType.Video:
                    ConstraintsType.Audio,
            );
            logger.log("Getting user media with constraints", constraints);
            this.setState(CallState.WaitLocalMedia);
            this.waitForLocalAVStream = true;

            try {
                const mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
                this.waitForLocalAVStream = false;
                this.gotUserMediaForAnswer(mediaStream);
            } catch (e) {
                this.getUserMediaFailed(e);
                return;
            }
        } else if (this.waitForLocalAVStream) {
            this.setState(CallState.WaitLocalMedia);
        }
    }

    /**
     * Replace this call with a new call, e.g. for glare resolution. Used by
     * MatrixClient.
     * @param {MatrixCall} newCall The new call.
     */
    replacedBy(newCall: MatrixCall) {
        if (this.state === CallState.WaitLocalMedia) {
            logger.debug("Telling new call to wait for local media");
            newCall.waitForLocalAVStream = true;
        } else if ([CallState.CreateOffer, CallState.InviteSent].includes(this.state)) {
            logger.debug("Handing local stream to new call");
            newCall.gotUserMediaForAnswer(this.localUsermediaStream);
        }
        this.successor = newCall;
        this.emit(CallEvent.Replaced, newCall);
        this.hangup(CallErrorCode.Replaced, true);
    }

    /**
     * Hangup a call.
     * @param {string} reason The reason why the call is being hung up.
     * @param {boolean} suppressEvent True to suppress emitting an event.
     */
    hangup(reason: CallErrorCode, suppressEvent: boolean) {
        if (this.callHasEnded()) return;

        logger.debug("Ending call " + this.callId);
        this.terminate(CallParty.Local, reason, !suppressEvent);
        // We don't want to send hangup here if we didn't even get to sending an invite
        if (this.state === CallState.WaitLocalMedia) return;
        const content = {};
        // Don't send UserHangup reason to older clients
        if ((this.opponentVersion && this.opponentVersion >= 1) || reason !== CallErrorCode.UserHangup) {
            content["reason"] = reason;
        }
        this.sendVoipEvent(EventType.CallHangup, content);
    }

    /**
     * Reject a call
     * This used to be done by calling hangup, but is a separate method and protocol
     * event as of MSC2746.
     */
    reject() {
        if (this.state !== CallState.Ringing) {
            throw Error("Call must be in 'ringing' state to reject!");
        }

        if (this.opponentVersion < 1) {
            logger.info(
                `Opponent version is less than 1 (${this.opponentVersion}): sending hangup instead of reject`,
            );
            this.hangup(CallErrorCode.UserHangup, true);
            return;
        }

        logger.debug("Rejecting call: " + this.callId);
        this.terminate(CallParty.Local, CallErrorCode.UserHangup, true);
        this.sendVoipEvent(EventType.CallReject, {});
    }

    /**
     * Returns true if this.remoteSDPStreamMetadata is defined, otherwise returns false
     * @returns {boolean} can screenshare
     */
    public opponentSupportsSDPStreamMetadata(): boolean {
        return Boolean(this.remoteSDPStreamMetadata);
    }

    /**
     * If there is a screensharing stream returns true, otherwise returns false
     * @returns {boolean} is screensharing
     */
    public isScreensharing(): boolean {
        return Boolean(this.localScreensharingStream);
    }

    /**
     * Starts/stops screensharing
     * @param enabled the desired screensharing state
     * @param selectDesktopCapturerSource callBack to select a screensharing stream on desktop
     * @returns {boolean} new screensharing state
     */
    public async setScreensharingEnabled(
        enabled: boolean,
        selectDesktopCapturerSource?: () => Promise<DesktopCapturerSource>,
    ) {
        // Skip if there is nothing to do
        if (enabled && this.isScreensharing()) {
            logger.warn(`There is already a screensharing stream - there is nothing to do!`);
            return true;
        } else if (!enabled && !this.isScreensharing()) {
            logger.warn(`There already isn't a screensharing stream - there is nothing to do!`);
            return false;
        }

        // Fallback to replaceTrack()
        if (!this.opponentSupportsSDPStreamMetadata()) {
            return await this.setScreensharingEnabledWithoutMetadataSupport(enabled, selectDesktopCapturerSource);
        }

        logger.debug(`Set screensharing enabled? ${enabled}`);
        if (enabled) {
            try {
                const stream = await getScreensharingStream(selectDesktopCapturerSource);
                if (!stream) return false;
                this.pushLocalFeed(stream, SDPStreamMetadataPurpose.Screenshare);
                return true;
            } catch (err) {
                this.emit(CallEvent.Error,
                    new CallError(CallErrorCode.NoUserMedia, "Failed to get screen-sharing stream: ", err),
                );
                return false;
            }
        } else {
            for (const sender of this.screensharingSenders) {
                this.peerConn.removeTrack(sender);
            }
            for (const track of this.localScreensharingStream.getTracks()) {
                track.stop();
            }
            this.deleteFeedByStream(this.localScreensharingStream);
            return false;
        }
    }

    /**
     * Starts/stops screensharing
     * Should be used ONLY if the opponent doesn't support SDPStreamMetadata
     * @param enabled the desired screensharing state
     * @param selectDesktopCapturerSource callBack to select a screensharing stream on desktop
     * @returns {boolean} new screensharing state
     */
    private async setScreensharingEnabledWithoutMetadataSupport(
        enabled: boolean,
        selectDesktopCapturerSource?: () => Promise<DesktopCapturerSource>,
    ) {
        logger.debug(`Set screensharing enabled? ${enabled} using replaceTrack()`);
        if (enabled) {
            try {
                const stream = await getScreensharingStream(selectDesktopCapturerSource);
                if (!stream) return false;

                const track = stream.getTracks().find((track) => {
                    return track.kind === "video";
                });
                const sender = this.usermediaSenders.find((sender) => {
                    return sender.track?.kind === "video";
                });
                sender.replaceTrack(track);

                this.pushLocalFeed(stream, SDPStreamMetadataPurpose.Screenshare, false);

                return true;
            } catch (err) {
                this.emit(CallEvent.Error,
                    new CallError(CallErrorCode.NoUserMedia, "Failed to get screen-sharing stream: ", err),
                );
                return false;
            }
        } else {
            const track = this.localUsermediaStream.getTracks().find((track) => {
                return track.kind === "video";
            });
            const sender = this.usermediaSenders.find((sender) => {
                return sender.track?.kind === "video";
            });
            sender.replaceTrack(track);

            for (const track of this.localScreensharingStream.getTracks()) {
                track.stop();
            }
            this.deleteFeedByStream(this.localScreensharingStream);

            return false;
        }
    }

    /**
     * Set whether our outbound video should be muted or not.
     * @param {boolean} muted True to mute the outbound video.
     */
    setLocalVideoMuted(muted: boolean) {
        this.localUsermediaFeed?.setVideoMuted(muted);
        this.updateMuteStatus();
    }

    /**
     * Check if local video is muted.
     *
     * If there are multiple video tracks, <i>all</i> of the tracks need to be muted
     * for this to return true. This means if there are no video tracks, this will
     * return true.
     * @return {Boolean} True if the local preview video is muted, else false
     * (including if the call is not set up yet).
     */
    isLocalVideoMuted(): boolean {
        return this.localUsermediaFeed?.isVideoMuted();
    }

    /**
     * Set whether the microphone should be muted or not.
     * @param {boolean} muted True to mute the mic.
     */
    setMicrophoneMuted(muted: boolean) {
        this.localUsermediaFeed?.setAudioMuted(muted);
        this.updateMuteStatus();
    }

    /**
     * Check if the microphone is muted.
     *
     * If there are multiple audio tracks, <i>all</i> of the tracks need to be muted
     * for this to return true. This means if there are no audio tracks, this will
     * return true.
     * @return {Boolean} True if the mic is muted, else false (including if the call
     * is not set up yet).
     */
    isMicrophoneMuted(): boolean {
        return this.localUsermediaFeed?.isAudioMuted();
    }

    /**
     * @returns true if we have put the party on the other side of the call on hold
     * (that is, we are signalling to them that we are not listening)
     */
    isRemoteOnHold(): boolean {
        return this.remoteOnHold;
    }

    setRemoteOnHold(onHold: boolean) {
        if (this.isRemoteOnHold() === onHold) return;
        this.remoteOnHold = onHold;

        for (const transceiver of this.peerConn.getTransceivers()) {
            // We don't send hold music or anything so we're not actually
            // sending anything, but sendrecv is fairly standard for hold and
            // it makes it a lot easier to figure out who's put who on hold.
            transceiver.direction = onHold ? 'sendonly' : 'sendrecv';
        }
        this.updateMuteStatus();

        this.emit(CallEvent.RemoteHoldUnhold, this.remoteOnHold);
    }

    /**
     * Indicates whether we are 'on hold' to the remote party (ie. if true,
     * they cannot hear us).
     * @returns true if the other party has put us on hold
     */
    isLocalOnHold(): boolean {
        if (this.state !== CallState.Connected) return false;

        let callOnHold = true;

        // We consider a call to be on hold only if *all* the tracks are on hold
        // (is this the right thing to do?)
        for (const transceiver of this.peerConn.getTransceivers()) {
            const trackOnHold = ['inactive', 'recvonly'].includes(transceiver.currentDirection);

            if (!trackOnHold) callOnHold = false;
        }

        return callOnHold;
    }

    /**
     * Sends a DTMF digit to the other party
     * @param digit The digit (nb. string - '#' and '*' are dtmf too)
     */
    sendDtmfDigit(digit: string) {
        for (const sender of this.peerConn.getSenders()) {
            if (sender.track.kind === 'audio' && sender.dtmf) {
                sender.dtmf.insertDTMF(digit);
                return;
            }
        }

        throw new Error("Unable to find a track to send DTMF on");
    }

    private updateMuteStatus() {
        this.sendVoipEvent(EventType.CallSDPStreamMetadataChangedPrefix, {
            [SDPStreamMetadataKey]: this.getLocalSDPStreamMetadata(),
        });

        const micShouldBeMuted = this.localUsermediaFeed?.isAudioMuted() || this.remoteOnHold;
        const vidShouldBeMuted = this.localUsermediaFeed?.isVideoMuted() || this.remoteOnHold;

        setTracksEnabled(this.localUsermediaStream.getAudioTracks(), !micShouldBeMuted);
        setTracksEnabled(this.localUsermediaStream.getVideoTracks(), !vidShouldBeMuted);
    }

    /**
     * Internal
     * @param {Object} stream
     */
    private gotUserMediaForInvite = async (stream: MediaStream) => {
        if (this.successor) {
            this.successor.gotUserMediaForAnswer(stream);
            return;
        }
        if (this.callHasEnded()) {
            this.stopAllMedia();
            return;
        }

        this.pushLocalFeed(stream, SDPStreamMetadataPurpose.Usermedia);
        this.setState(CallState.CreateOffer);

        logger.debug("gotUserMediaForInvite -> " + this.type);
        // Now we wait for the negotiationneeded event
    };

    private async sendAnswer() {
        const answerContent = {
            answer: {
                sdp: this.peerConn.localDescription.sdp,
                // type is now deprecated as of Matrix VoIP v1, but
                // required to still be sent for backwards compat
                type: this.peerConn.localDescription.type,
            },
            [SDPStreamMetadataKey]: this.getLocalSDPStreamMetadata(),
        } as MCallAnswer;

        answerContent.capabilities = {
            'm.call.transferee': this.client.supportsCallTransfer,
            'm.call.dtmf': false,
        };

        // We have just taken the local description from the peerConn which will
        // contain all the local candidates added so far, so we can discard any candidates
        // we had queued up because they'll be in the answer.
        logger.info(`Discarding ${this.candidateSendQueue.length} candidates that will be sent in answer`);
        this.candidateSendQueue = [];

        try {
            await this.sendVoipEvent(EventType.CallAnswer, answerContent);
            // If this isn't the first time we've tried to send the answer,
            // we may have candidates queued up, so send them now.
            this.inviteOrAnswerSent = true;
        } catch (error) {
            // We've failed to answer: back to the ringing state
            this.setState(CallState.Ringing);
            this.client.cancelPendingEvent(error.event);

            let code = CallErrorCode.SendAnswer;
            let message = "Failed to send answer";
            if (error.name == 'UnknownDeviceError') {
                code = CallErrorCode.UnknownDevices;
                message = "Unknown devices present in the room";
            }
            this.emit(CallEvent.Error, new CallError(code, message, error));
            throw error;
        }

        // error handler re-throws so this won't happen on error, but
        // we don't want the same error handling on the candidate queue
        this.sendCandidateQueue();
    }

    private gotUserMediaForAnswer = async (stream: MediaStream) => {
        if (this.callHasEnded()) {
            return;
        }

        this.pushLocalFeed(stream, SDPStreamMetadataPurpose.Usermedia);
        this.setState(CallState.CreateAnswer);

        let myAnswer;
        try {
            this.getRidOfRTXCodecs();
            myAnswer = await this.peerConn.createAnswer();
        } catch (err) {
            logger.debug("Failed to create answer: ", err);
            this.terminate(CallParty.Local, CallErrorCode.CreateAnswer, true);
            return;
        }

        try {
            await this.peerConn.setLocalDescription(myAnswer);
            this.setState(CallState.Connecting);

            // Allow a short time for initial candidates to be gathered
            await new Promise(resolve => {
                setTimeout(resolve, 200);
            });

            this.sendAnswer();
        } catch (err) {
            logger.debug("Error setting local description!", err);
            this.terminate(CallParty.Local, CallErrorCode.SetLocalDescription, true);
            return;
        }
    };

    /**
     * Internal
     * @param {Object} event
     */
    private gotLocalIceCandidate = (event: RTCPeerConnectionIceEvent) => {
        if (event.candidate) {
            logger.debug(
                "Call " + this.callId + " got local ICE " + event.candidate.sdpMid + " candidate: " +
                event.candidate.candidate,
            );

            if (this.callHasEnded()) return;

            // As with the offer, note we need to make a copy of this object, not
            // pass the original: that broke in Chrome ~m43.
            if (event.candidate.candidate !== '' || !this.sentEndOfCandidates) {
                this.queueCandidate(event.candidate);

                if (event.candidate.candidate === '') this.sentEndOfCandidates = true;
            }
        }
    };

    private onIceGatheringStateChange = (event: Event) => {
        logger.debug("ice gathering state changed to " + this.peerConn.iceGatheringState);
        if (this.peerConn.iceGatheringState === 'complete' && !this.sentEndOfCandidates) {
            // If we didn't get an empty-string candidate to signal the end of candidates,
            // create one ourselves now gathering has finished.
            // We cast because the interface lists all the properties as required but we
            // only want to send 'candidate'
            // XXX: We probably want to send either sdpMid or sdpMLineIndex, as it's not strictly
            // correct to have a candidate that lacks both of these. We'd have to figure out what
            // previous candidates had been sent with and copy them.
            const c = {
                candidate: '',
            } as RTCIceCandidate;
            this.queueCandidate(c);
            this.sentEndOfCandidates = true;
        }
    };

    async onRemoteIceCandidatesReceived(ev: MatrixEvent) {
        if (this.callHasEnded()) {
            //debuglog("Ignoring remote ICE candidate because call has ended");
            return;
        }

        const candidates = ev.getContent().candidates;
        if (!candidates) {
            logger.info("Ignoring candidates event with no candidates!");
            return;
        }

        const fromPartyId = ev.getContent().version === 0 ? null : ev.getContent().party_id || null;

        if (this.opponentPartyId === undefined) {
            // we haven't picked an opponent yet so save the candidates
            logger.info(`Buffering ${candidates.length} candidates until we pick an opponent`);
            const bufferedCandidates = this.remoteCandidateBuffer.get(fromPartyId) || [];
            bufferedCandidates.push(...candidates);
            this.remoteCandidateBuffer.set(fromPartyId, bufferedCandidates);
            return;
        }

        if (!this.partyIdMatches(ev.getContent())) {
            logger.info(
                `Ignoring candidates from party ID ${ev.getContent().party_id}: ` +
                `we have chosen party ID ${this.opponentPartyId}`,
            );

            return;
        }

        await this.addIceCandidates(candidates);
    }

    /**
     * Used by MatrixClient.
     * @param {Object} msg
     */
    async onAnswerReceived(event: MatrixEvent) {
        logger.debug(`Got answer for call ID ${this.callId} from party ID ${event.getContent().party_id}`);

        if (this.callHasEnded()) {
            logger.debug(`Ignoring answer because call ID ${this.callId} has ended`);
            return;
        }

        if (this.opponentPartyId !== undefined) {
            logger.info(
                `Ignoring answer from party ID ${event.getContent().party_id}: ` +
                `we already have an answer/reject from ${this.opponentPartyId}`,
            );
            return;
        }

        this.chooseOpponent(event);
        await this.addBufferedIceCandidates();

        this.setState(CallState.Connecting);

        const sdpStreamMetadata = event.getContent()[SDPStreamMetadataKey];
        if (sdpStreamMetadata) {
            this.updateRemoteSDPStreamMetadata(sdpStreamMetadata);
        } else {
            logger.warn("Did not get any SDPStreamMetadata! Can not send/receive multiple streams");
        }

        try {
            await this.peerConn.setRemoteDescription(event.getContent().answer);
        } catch (e) {
            logger.debug("Failed to set remote description", e);
            this.terminate(CallParty.Local, CallErrorCode.SetRemoteDescription, false);
            return;
        }

        // If the answer we selected has a party_id, send a select_answer event
        // We do this after setting the remote description since otherwise we'd block
        // call setup on it
        if (this.opponentPartyId !== null) {
            try {
                await this.sendVoipEvent(EventType.CallSelectAnswer, {
                    selected_party_id: this.opponentPartyId,
                });
            } catch (err) {
                // This isn't fatal, and will just mean that if another party has raced to answer
                // the call, they won't know they got rejected, so we carry on & don't retry.
                logger.warn("Failed to send select_answer event", err);
            }
        }
    }

    async onSelectAnswerReceived(event: MatrixEvent) {
        if (this.direction !== CallDirection.Inbound) {
            logger.warn("Got select_answer for an outbound call: ignoring");
            return;
        }

        const selectedPartyId = event.getContent().selected_party_id;

        if (selectedPartyId === undefined || selectedPartyId === null) {
            logger.warn("Got nonsensical select_answer with null/undefined selected_party_id: ignoring");
            return;
        }

        if (selectedPartyId !== this.ourPartyId) {
            logger.info(`Got select_answer for party ID ${selectedPartyId}: we are party ID ${this.ourPartyId}.`);
            // The other party has picked somebody else's answer
            this.terminate(CallParty.Remote, CallErrorCode.AnsweredElsewhere, true);
        }
    }

    async onNegotiateReceived(event: MatrixEvent) {
        const description = event.getContent().description;
        if (!description || !description.sdp || !description.type) {
            logger.info("Ignoring invalid m.call.negotiate event");
            return;
        }
        // Politeness always follows the direction of the call: in a glare situation,
        // we pick either the inbound or outbound call, so one side will always be
        // inbound and one outbound
        const polite = this.direction === CallDirection.Inbound;

        // Here we follow the perfect negotiation logic from
        // https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation
        const offerCollision = (
            (description.type === 'offer') &&
            (this.makingOffer || this.peerConn.signalingState !== 'stable')
        );

        this.ignoreOffer = !polite && offerCollision;
        if (this.ignoreOffer) {
            logger.info("Ignoring colliding negotiate event because we're impolite");
            return;
        }

        const prevLocalOnHold = this.isLocalOnHold();

        const sdpStreamMetadata = event.getContent()[SDPStreamMetadataKey];
        if (sdpStreamMetadata) {
            this.updateRemoteSDPStreamMetadata(sdpStreamMetadata);
        } else {
            logger.warn("Received negotiation event without SDPStreamMetadata!");
        }

        try {
            await this.peerConn.setRemoteDescription(description);

            if (description.type === 'offer') {
                this.getRidOfRTXCodecs();
                const localDescription = await this.peerConn.createAnswer();
                await this.peerConn.setLocalDescription(localDescription);

                this.sendVoipEvent(EventType.CallNegotiate, {
                    description: this.peerConn.localDescription,
                    [SDPStreamMetadataKey]: this.getLocalSDPStreamMetadata(),
                });
            }
        } catch (err) {
            logger.warn("Failed to complete negotiation", err);
        }

        const newLocalOnHold = this.isLocalOnHold();
        if (prevLocalOnHold !== newLocalOnHold) {
            this.emit(CallEvent.LocalHoldUnhold, newLocalOnHold);
            // also this one for backwards compat
            this.emit(CallEvent.HoldUnhold, newLocalOnHold);
        }
    }

    private updateRemoteSDPStreamMetadata(metadata: SDPStreamMetadata): void {
        this.remoteSDPStreamMetadata = recursivelyAssign(this.remoteSDPStreamMetadata || {}, metadata, true);
        for (const feed of this.getRemoteFeeds()) {
            const streamId = feed.stream.id;
            feed.setAudioMuted(this.remoteSDPStreamMetadata[streamId]?.audio_muted);
            feed.setVideoMuted(this.remoteSDPStreamMetadata[streamId]?.video_muted);
            feed.purpose = this.remoteSDPStreamMetadata[streamId]?.purpose;
        }
    }

    public onSDPStreamMetadataChangedReceived(event: MatrixEvent): void {
        const content = event.getContent<MCallSDPStreamMetadataChanged>();
        const metadata = content[SDPStreamMetadataKey];
        this.updateRemoteSDPStreamMetadata(metadata);
    }

    async onAssertedIdentityReceived(event: MatrixEvent) {
        if (!event.getContent().asserted_identity) return;

        this.remoteAssertedIdentity = {
            id: event.getContent().asserted_identity.id,
            displayName: event.getContent().asserted_identity.display_name,
        };
        this.emit(CallEvent.AssertedIdentityChanged);
    }

    private callHasEnded(): boolean {
        // This exists as workaround to typescript trying to be clever and erroring
        // when putting if (this.state === CallState.Ended) return; twice in the same
        // function, even though that function is async.
        return this.state === CallState.Ended;
    }

    private gotLocalOffer = async (description: RTCSessionDescriptionInit) => {
        logger.debug("Created offer: ", description);

        if (this.callHasEnded()) {
            logger.debug("Ignoring newly created offer on call ID " + this.callId +
                " because the call has ended");
            return;
        }

        try {
            await this.peerConn.setLocalDescription(description);
        } catch (err) {
            logger.debug("Error setting local description!", err);
            this.terminate(CallParty.Local, CallErrorCode.SetLocalDescription, true);
            return;
        }

        if (this.peerConn.iceGatheringState === 'gathering') {
            // Allow a short time for initial candidates to be gathered
            await new Promise(resolve => {
                setTimeout(resolve, 200);
            });
        }

        if (this.callHasEnded()) return;

        const eventType = this.state === CallState.CreateOffer ? EventType.CallInvite : EventType.CallNegotiate;

        const content = {
            lifetime: CALL_TIMEOUT_MS,
        } as MCallOfferNegotiate;

        // clunky because TypeScript can't follow the types through if we use an expression as the key
        if (this.state === CallState.CreateOffer) {
            content.offer = this.peerConn.localDescription;
        } else {
            content.description = this.peerConn.localDescription;
        }

        content.capabilities = {
            'm.call.transferee': this.client.supportsCallTransfer,
            'm.call.dtmf': false,
        };

        content[SDPStreamMetadataKey] = this.getLocalSDPStreamMetadata();

        // Get rid of any candidates waiting to be sent: they'll be included in the local
        // description we just got and will send in the offer.
        logger.info(`Discarding ${this.candidateSendQueue.length} candidates that will be sent in offer`);
        this.candidateSendQueue = [];

        try {
            await this.sendVoipEvent(eventType, content);
        } catch (error) {
            logger.error("Failed to send invite", error);
            if (error.event) this.client.cancelPendingEvent(error.event);

            let code = CallErrorCode.SignallingFailed;
            let message = "Signalling failed";
            if (this.state === CallState.CreateOffer) {
                code = CallErrorCode.SendInvite;
                message = "Failed to send invite";
            }
            if (error.name == 'UnknownDeviceError') {
                code = CallErrorCode.UnknownDevices;
                message = "Unknown devices present in the room";
            }

            this.emit(CallEvent.Error, new CallError(code, message, error));
            this.terminate(CallParty.Local, code, false);

            // no need to carry on & send the candidate queue, but we also
            // don't want to rethrow the error
            return;
        }

        this.sendCandidateQueue();
        if (this.state === CallState.CreateOffer) {
            this.inviteOrAnswerSent = true;
            this.setState(CallState.InviteSent);
            this.inviteTimeout = setTimeout(() => {
                this.inviteTimeout = null;
                if (this.state === CallState.InviteSent) {
                    this.hangup(CallErrorCode.InviteTimeout, false);
                }
            }, CALL_TIMEOUT_MS);
        }
    };

    private getLocalOfferFailed = (err: Error) => {
        logger.error("Failed to get local offer", err);

        this.emit(
            CallEvent.Error,
            new CallError(
                CallErrorCode.LocalOfferFailed,
                "Failed to get local offer!", err,
            ),
        );
        this.terminate(CallParty.Local, CallErrorCode.LocalOfferFailed, false);
    };

    private getUserMediaFailed = (err: Error) => {
        if (this.successor) {
            this.successor.getUserMediaFailed(err);
            return;
        }

        logger.warn("Failed to get user media - ending call", err);

        this.emit(
            CallEvent.Error,
            new CallError(
                CallErrorCode.NoUserMedia,
                "Couldn't start capturing media! Is your microphone set up and " +
                "does this app have permission?", err,
            ),
        );
        this.terminate(CallParty.Local, CallErrorCode.NoUserMedia, false);
    };

    onIceConnectionStateChanged = () => {
        if (this.callHasEnded()) {
            return; // because ICE can still complete as we're ending the call
        }
        logger.debug(
            "Call ID " + this.callId + ": ICE connection state changed to: " + this.peerConn.iceConnectionState,
        );
        // ideally we'd consider the call to be connected when we get media but
        // chrome doesn't implement any of the 'onstarted' events yet
        if (this.peerConn.iceConnectionState == 'connected') {
            this.setState(CallState.Connected);
        } else if (this.peerConn.iceConnectionState == 'failed') {
            this.hangup(CallErrorCode.IceFailed, false);
        }
    };

    private onSignallingStateChanged = () => {
        logger.debug(
            "call " + this.callId + ": Signalling state changed to: " +
            this.peerConn.signalingState,
        );
    };

    private onTrack = (ev: RTCTrackEvent) => {
        if (ev.streams.length === 0) {
            logger.warn(`Streamless ${ev.track.kind} found: ignoring.`);
            return;
        }

        const stream = ev.streams[0];
        this.pushRemoteFeed(stream);
        stream.addEventListener("removetrack", () => this.deleteFeedByStream(stream));
    };

    /**
     * This method removes all video/rtx codecs from screensharing video
     * transceivers. This is necessary since they can cause problems. Without
     * this the following steps should produce an error:
     *   Chromium calls Firefox
     *   Firefox answers
     *   Firefox starts screen-sharing
     *   Chromium starts screen-sharing
     *   Call crashes for Chromium with:
     *       [96685:23:0518/162603.933321:ERROR:webrtc_video_engine.cc(3296)] RTX codec (PT=97) mapped to PT=96 which is not in the codec list.
     *       [96685:23:0518/162603.933377:ERROR:webrtc_video_engine.cc(1171)] GetChangedRecvParameters called without any video codecs.
     *       [96685:23:0518/162603.933430:ERROR:sdp_offer_answer.cc(4302)] Failed to set local video description recv parameters for m-section with mid='2'. (INVALID_PARAMETER)
     */
    private getRidOfRTXCodecs() {
        // RTCRtpReceiver.getCapabilities and RTCRtpSender.getCapabilities don't seem to be supported on FF
        if (!RTCRtpReceiver.getCapabilities || !RTCRtpSender.getCapabilities) return;

        const recvCodecs = RTCRtpReceiver.getCapabilities("video").codecs;
        const sendCodecs = RTCRtpSender.getCapabilities("video").codecs;
        const codecs = [...sendCodecs, ...recvCodecs];

        for (const codec of codecs) {
            if (codec.mimeType === "video/rtx") {
                const rtxCodecIndex = codecs.indexOf(codec);
                codecs.splice(rtxCodecIndex, 1);
            }
        }

        for (const trans of this.peerConn.getTransceivers()) {
            if (
                this.screensharingSenders.includes(trans.sender) &&
                    (
                        trans.sender.track?.kind === "video" ||
                        trans.receiver.track?.kind === "video"
                    )
            ) {
                trans.setCodecPreferences(codecs);
            }
        }
    }

    onNegotiationNeeded = async () => {
        logger.info("Negotiation is needed!");

        if (this.state !== CallState.CreateOffer && this.opponentVersion === 0) {
            logger.info("Opponent does not support renegotiation: ignoring negotiationneeded event");
            return;
        }

        this.makingOffer = true;
        try {
            this.getRidOfRTXCodecs();
            const myOffer = await this.peerConn.createOffer();
            await this.gotLocalOffer(myOffer);
        } catch (e) {
            this.getLocalOfferFailed(e);
            return;
        } finally {
            this.makingOffer = false;
        }
    };

    onHangupReceived = (msg) => {
        logger.debug("Hangup received for call ID " + this.callId);

        // party ID must match (our chosen partner hanging up the call) or be undefined (we haven't chosen
        // a partner yet but we're treating the hangup as a reject as per VoIP v0)
        if (this.partyIdMatches(msg) || this.state === CallState.Ringing) {
            // default reason is user_hangup
            this.terminate(CallParty.Remote, msg.reason || CallErrorCode.UserHangup, true);
        } else {
            logger.info(`Ignoring message from party ID ${msg.party_id}: our partner is ${this.opponentPartyId}`);
        }
    };

    onRejectReceived = (msg) => {
        logger.debug("Reject received for call ID " + this.callId);

        // No need to check party_id for reject because if we'd received either
        // an answer or reject, we wouldn't be in state InviteSent

        const shouldTerminate = (
            // reject events also end the call if it's ringing: it's another of
            // our devices rejecting the call.
            ([CallState.InviteSent, CallState.Ringing].includes(this.state)) ||
            // also if we're in the init state and it's an inbound call, since
            // this means we just haven't entered the ringing state yet
            this.state === CallState.Fledgling && this.direction === CallDirection.Inbound
        );

        if (shouldTerminate) {
            this.terminate(CallParty.Remote, msg.reason || CallErrorCode.UserHangup, true);
        } else {
            logger.debug(`Call is in state: ${this.state}: ignoring reject`);
        }
    };

    onAnsweredElsewhere = (msg) => {
        logger.debug("Call ID " + this.callId + " answered elsewhere");
        this.terminate(CallParty.Remote, CallErrorCode.AnsweredElsewhere, true);
    };

    setState(state: CallState) {
        const oldState = this.state;
        this.state = state;
        this.emit(CallEvent.State, state, oldState);
    }

    /**
     * Internal
     * @param {string} eventType
     * @param {Object} content
     * @return {Promise}
     */
    private sendVoipEvent(eventType: string, content: object) {
        return this.client.sendEvent(this.roomId, eventType, Object.assign({}, content, {
            version: VOIP_PROTO_VERSION,
            call_id: this.callId,
            party_id: this.ourPartyId,
        }));
    }

    queueCandidate(content: RTCIceCandidate) {
        // We partially de-trickle candidates by waiting for `delay` before sending them
        // amalgamated, in order to avoid sending too many m.call.candidates events and hitting
        // rate limits in Matrix.
        // In practice, it'd be better to remove rate limits for m.call.*

        // N.B. this deliberately lets you queue and send blank candidates, which MSC2746
        // currently proposes as the way to indicate that candidate gathering is complete.
        // This will hopefully be changed to an explicit rather than implicit notification
        // shortly.
        this.candidateSendQueue.push(content);

        // Don't send the ICE candidates yet if the call is in the ringing state: this
        // means we tried to pick (ie. started generating candidates) and then failed to
        // send the answer and went back to the ringing state. Queue up the candidates
        // to send if we successfully send the answer.
        // Equally don't send if we haven't yet sent the answer because we can send the
        // first batch of candidates along with the answer
        if (this.state === CallState.Ringing || !this.inviteOrAnswerSent) return;

        // MSC2746 recommends these values (can be quite long when calling because the
        // callee will need a while to answer the call)
        const delay = this.direction === CallDirection.Inbound ? 500 : 2000;

        if (this.candidateSendTries === 0) {
            setTimeout(() => {
                this.sendCandidateQueue();
            }, delay);
        }
    }

    /*
     * Transfers this call to another user
     */
    async transfer(targetUserId: string) {
        // Fetch the target user's global profile info: their room avatar / displayname
        // could be different in whatever room we share with them.
        const profileInfo = await this.client.getProfileInfo(targetUserId);

        const replacementId = genCallID();

        const body = {
            replacement_id: genCallID(),
            target_user: {
                id: targetUserId,
                display_name: profileInfo.display_name,
                avatar_url: profileInfo.avatar_url,
            },
            create_call: replacementId,
        } as MCallReplacesEvent;

        await this.sendVoipEvent(EventType.CallReplaces, body);

        await this.terminate(CallParty.Local, CallErrorCode.Transfered, true);
    }

    /*
     * Transfers this call to the target call, effectively 'joining' the
     * two calls (so the remote parties on each call are connected together).
     */
    async transferToCall(transferTargetCall?: MatrixCall) {
        const targetProfileInfo = await this.client.getProfileInfo(transferTargetCall.getOpponentMember().userId);
        const transfereeProfileInfo = await this.client.getProfileInfo(this.getOpponentMember().userId);

        const newCallId = genCallID();

        const bodyToTransferTarget = {
            // the replacements on each side have their own ID, and it's distinct from the
            // ID of the new call (but we can use the same function to generate it)
            replacement_id: genCallID(),
            target_user: {
                id: this.getOpponentMember().userId,
                display_name: transfereeProfileInfo.display_name,
                avatar_url: transfereeProfileInfo.avatar_url,
            },
            await_call: newCallId,
        } as MCallReplacesEvent;

        await transferTargetCall.sendVoipEvent(EventType.CallReplaces, bodyToTransferTarget);

        const bodyToTransferee = {
            replacement_id: genCallID(),
            target_user: {
                id: transferTargetCall.getOpponentMember().userId,
                display_name: targetProfileInfo.display_name,
                avatar_url: targetProfileInfo.avatar_url,
            },
            create_call: newCallId,
        } as MCallReplacesEvent;

        await this.sendVoipEvent(EventType.CallReplaces, bodyToTransferee);

        await this.terminate(CallParty.Local, CallErrorCode.Replaced, true);
        await transferTargetCall.terminate(CallParty.Local, CallErrorCode.Transfered, true);
    }

    private async terminate(hangupParty: CallParty, hangupReason: CallErrorCode, shouldEmit: boolean) {
        if (this.callHasEnded()) return;

        this.callStatsAtEnd = await this.collectCallStats();

        if (this.inviteTimeout) {
            clearTimeout(this.inviteTimeout);
            this.inviteTimeout = null;
        }

        // Order is important here: first we stopAllMedia() and only then we can deleteAllFeeds()
        // We don't stop media if the call was replaced as we want to re-use streams in the successor
        if (hangupReason !== CallErrorCode.Replaced) this.stopAllMedia();
        this.deleteAllFeeds();

        this.hangupParty = hangupParty;
        this.hangupReason = hangupReason;
        this.setState(CallState.Ended);
        if (this.peerConn && this.peerConn.signalingState !== 'closed') {
            this.peerConn.close();
        }
        if (shouldEmit) {
            this.emit(CallEvent.Hangup, this);
        }
    }

    private stopAllMedia() {
        logger.debug(`stopAllMedia (stream=${this.localUsermediaStream})`);

        for (const feed of this.feeds) {
            for (const track of feed.stream.getTracks()) {
                track.stop();
            }
        }
    }

    private checkForErrorListener() {
        if (this.listeners("error").length === 0) {
            throw new Error(
                "You MUST attach an error listener using call.on('error', function() {})",
            );
        }
    }

    private async sendCandidateQueue() {
        if (this.candidateSendQueue.length === 0) {
            return;
        }

        const candidates = this.candidateSendQueue;
        this.candidateSendQueue = [];
        ++this.candidateSendTries;
        const content = {
            candidates: candidates,
        };
        logger.debug("Attempting to send " + candidates.length + " candidates");
        try {
            await this.sendVoipEvent(EventType.CallCandidates, content);
            // reset our retry count if we have successfully sent our candidates
            // otherwise queueCandidate() will refuse to try to flush the queue
            this.candidateSendTries = 0;
        } catch (error) {
            // don't retry this event: we'll send another one later as we might
            // have more candidates by then.
            if (error.event) this.client.cancelPendingEvent(error.event);

            // put all the candidates we failed to send back in the queue
            this.candidateSendQueue.push(...candidates);

            if (this.candidateSendTries > 5) {
                logger.debug(
                    "Failed to send candidates on attempt " + this.candidateSendTries +
                    ". Giving up on this call.", error,
                );

                const code = CallErrorCode.SignallingFailed;
                const message = "Signalling failed";

                this.emit(CallEvent.Error, new CallError(code, message, error));
                this.hangup(code, false);

                return;
            }

            const delayMs = 500 * Math.pow(2, this.candidateSendTries);
            ++this.candidateSendTries;
            logger.debug("Failed to send candidates. Retrying in " + delayMs + "ms", error);
            setTimeout(() => {
                this.sendCandidateQueue();
            }, delayMs);
        }
    }

    private async placeCallWithConstraints(constraints: MediaStreamConstraints) {
        logger.log("Getting user media with constraints", constraints);
        // XXX Find a better way to do this
        this.client.callEventHandler.calls.set(this.callId, this);
        this.setState(CallState.WaitLocalMedia);
        this.direction = CallDirection.Outbound;

        // make sure we have valid turn creds. Unless something's gone wrong, it should
        // poll and keep the credentials valid so this should be instant.
        const haveTurnCreds = await this.client.checkTurnServers();
        if (!haveTurnCreds) {
            logger.warn("Failed to get TURN credentials! Proceeding with call anyway...");
        }

        // create the peer connection now so it can be gathering candidates while we get user
        // media (assuming a candidate pool size is configured)
        this.peerConn = this.createPeerConnection();

        try {
            const mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
            this.gotUserMediaForInvite(mediaStream);
        } catch (e) {
            this.getUserMediaFailed(e);
            return;
        }
    }

    private createPeerConnection(): RTCPeerConnection {
        const pc = new window.RTCPeerConnection({
            iceTransportPolicy: this.forceTURN ? 'relay' : undefined,
            iceServers: this.turnServers,
            iceCandidatePoolSize: this.client.iceCandidatePoolSize,
        });

        // 'connectionstatechange' would be better, but firefox doesn't implement that.
        pc.addEventListener('iceconnectionstatechange', this.onIceConnectionStateChanged);
        pc.addEventListener('signalingstatechange', this.onSignallingStateChanged);
        pc.addEventListener('icecandidate', this.gotLocalIceCandidate);
        pc.addEventListener('icegatheringstatechange', this.onIceGatheringStateChange);
        pc.addEventListener('track', this.onTrack);
        pc.addEventListener('negotiationneeded', this.onNegotiationNeeded);

        return pc;
    }

    private partyIdMatches(msg): boolean {
        // They must either match or both be absent (in which case opponentPartyId will be null)
        // Also we ignore party IDs on the invite/offer if the version is 0, so we must do the same
        // here and use null if the version is 0 (woe betide any opponent sending messages in the
        // same call with different versions)
        const msgPartyId = msg.version === 0 ? null : msg.party_id || null;
        return msgPartyId === this.opponentPartyId;
    }

    // Commits to an opponent for the call
    // ev: An invite or answer event
    private chooseOpponent(ev: MatrixEvent) {
        // I choo-choo-choose you
        const msg = ev.getContent();

        logger.debug(`Choosing party ID ${msg.party_id} for call ID ${this.callId}`);

        this.opponentVersion = msg.version;
        if (this.opponentVersion === 0) {
            // set to null to indicate that we've chosen an opponent, but because
            // they're v0 they have no party ID (even if they sent one, we're ignoring it)
            this.opponentPartyId = null;
        } else {
            // set to their party ID, or if they're naughty and didn't send one despite
            // not being v0, set it to null to indicate we picked an opponent with no
            // party ID
            this.opponentPartyId = msg.party_id || null;
        }
        this.opponentCaps = msg.capabilities || {};
        this.opponentMember = ev.sender;
    }

    private async addBufferedIceCandidates() {
        const bufferedCandidates = this.remoteCandidateBuffer.get(this.opponentPartyId);
        if (bufferedCandidates) {
            logger.info(`Adding ${bufferedCandidates.length} buffered candidates for opponent ${this.opponentPartyId}`);
            await this.addIceCandidates(bufferedCandidates);
        }
        this.remoteCandidateBuffer = null;
    }

    private async addIceCandidates(candidates: RTCIceCandidate[]) {
        for (const candidate of candidates) {
            if (
                (candidate.sdpMid === null || candidate.sdpMid === undefined) &&
                (candidate.sdpMLineIndex === null || candidate.sdpMLineIndex === undefined)
            ) {
                logger.debug("Ignoring remote ICE candidate with no sdpMid or sdpMLineIndex");
                continue;
            }
            logger.debug(
                "Call " + this.callId + " got remote ICE " + candidate.sdpMid + " candidate: " + candidate.candidate,
            );
            try {
                await this.peerConn.addIceCandidate(candidate);
            } catch (err) {
                if (!this.ignoreOffer) {
                    logger.info("Failed to add remote ICE candidate", err);
                }
            }
        }
    }

    public get hasPeerConnection() {
        return Boolean(this.peerConn);
    }
}

async function getScreensharingStream(
    selectDesktopCapturerSource?: () => Promise<DesktopCapturerSource>,
): Promise<MediaStream> {
    const screenshareConstraints = await getScreenshareContraints(selectDesktopCapturerSource);
    if (!screenshareConstraints) return null;

    if (window.electron?.getDesktopCapturerSources) {
        // We are using Electron
        logger.debug("Getting screen stream using getUserMedia()...");
        return await navigator.mediaDevices.getUserMedia(screenshareConstraints);
    } else {
        // We are not using Electron
        logger.debug("Getting screen stream using getDisplayMedia()...");
        return await navigator.mediaDevices.getDisplayMedia(screenshareConstraints);
    }
}

function setTracksEnabled(tracks: Array<MediaStreamTrack>, enabled: boolean) {
    for (let i = 0; i < tracks.length; i++) {
        tracks[i].enabled = enabled;
    }
}

function getUserMediaContraints(type: ConstraintsType) {
    const isWebkit = !!navigator.webkitGetUserMedia;

    switch (type) {
        case ConstraintsType.Audio: {
            return {
                audio: {
                    deviceId: audioInput ? { ideal: audioInput } : undefined,
                },
                video: false,
            };
        }
        case ConstraintsType.Video: {
            return {
                audio: {
                    deviceId: audioInput ? { ideal: audioInput } : undefined,
                }, video: {
                    deviceId: videoInput ? { ideal: videoInput } : undefined,
                    /* We want 640x360.  Chrome will give it only if we ask exactly,
                       FF refuses entirely if we ask exactly, so have to ask for ideal
                       instead
                       XXX: Is this still true?
                     */
                    width: isWebkit ? { exact: 640 } : { ideal: 640 },
                    height: isWebkit ? { exact: 360 } : { ideal: 360 },
                },
            };
        }
    }
}

async function getScreenshareContraints(selectDesktopCapturerSource?: () => Promise<DesktopCapturerSource>) {
    if (window.electron?.getDesktopCapturerSources && selectDesktopCapturerSource) {
        // We have access to getDesktopCapturerSources()
        logger.debug("Electron getDesktopCapturerSources() is available...");
        const selectedSource = await selectDesktopCapturerSource();
        if (!selectedSource) return null;
        return {
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: "desktop",
                    chromeMediaSourceId: selectedSource.id,
                },
            },
        };
    } else {
        // We do not have access to the Electron desktop capturer,
        // therefore we can assume we are on the web
        logger.debug("Electron desktopCapturer is not available...");
        return {
            audio: false,
            video: true,
        };
    }
}

let audioInput: string;
let videoInput: string;
/**
 * Set an audio input device to use for MatrixCalls
 * @function
 * @param {string=} deviceId the identifier for the device
 * undefined treated as unset
 */
export function setAudioInput(deviceId: string) { audioInput = deviceId; }
/**
 * Set a video input device to use for MatrixCalls
 * @function
 * @param {string=} deviceId the identifier for the device
 * undefined treated as unset
 */
export function setVideoInput(deviceId: string) { videoInput = deviceId; }

/**
 * DEPRECATED
 * Use client.createCall()
 *
 * Create a new Matrix call for the browser.
 * @param {MatrixClient} client The client instance to use.
 * @param {string} roomId The room the call is in.
 * @param {Object?} options DEPRECATED optional options map.
 * @param {boolean} options.forceTURN DEPRECATED whether relay through TURN should be
 * forced. This option is deprecated - use opts.forceTURN when creating the matrix client
 * since it's only possible to set this option on outbound calls.
 * @return {MatrixCall} the call or null if the browser doesn't support calling.
 */
export function createNewMatrixCall(client: any, roomId: string, options?: CallOpts) {
    // typeof prevents Node from erroring on an undefined reference
    if (typeof(window) === 'undefined' || typeof(document) === 'undefined') {
        // NB. We don't log here as apps try to create a call object as a test for
        // whether calls are supported, so we shouldn't fill the logs up.
        return null;
    }

    // Firefox throws on so little as accessing the RTCPeerConnection when operating in
    // a secure mode. There's some information at https://bugzilla.mozilla.org/show_bug.cgi?id=1542616
    // though the concern is that the browser throwing a SecurityError will brick the
    // client creation process.
    try {
        const supported = Boolean(
            window.RTCPeerConnection || window.RTCSessionDescription ||
            window.RTCIceCandidate || navigator.mediaDevices,
        );
        if (!supported) {
            // Adds a lot of noise to test runs, so disable logging there.
            if (process.env.NODE_ENV !== "test") {
                logger.error("WebRTC is not supported in this browser / environment");
            }
            return null;
        }
    } catch (e) {
        logger.error("Exception thrown when trying to access WebRTC", e);
        return null;
    }

    const optionsForceTURN = options ? options.forceTURN : false;

    const opts = {
        client: client,
        roomId: roomId,
        turnServers: client.getTurnServers(),
        // call level options
        forceTURN: client.forceTURN || optionsForceTURN,
    };
    const call = new MatrixCall(opts);

    client.reEmitter.reEmit(call, Object.values(CallEvent));

    return call;
}
