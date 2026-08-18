/**
 * webrtc.js — Shared WebRTC module for PhoneCam Pro
 * Handles peer connection setup, ICE negotiation, and stream management
 */

class PhoneCamRTC {
    constructor(role, socket, roomId) {
        this.role = role; // 'mobile' or 'desktop'
        this.socket = socket;
        this.roomId = roomId;
        this.peerConnection = null;
        this.localStream = null;
        this.remoteStream = null;
        this.dataChannel = null;
        this.onRemoteStream = null;
        this.onDataChannel = null;
        this.onConnectionStateChange = null;
        this.onStats = null;
        this.statsInterval = null;
        this.reconnectAttempts = 0;
        this.isConnected = false;
    }

    /**
     * Initialize peer connection with ICE servers
     */
    createPeerConnection() {
        const config = {
            iceServers: PHONECAM.ICE_SERVERS,
            iceCandidatePoolSize: 10
        };

        this.peerConnection = new RTCPeerConnection(config);

        // Handle ICE candidates
        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                this.socket.emit(PHONECAM.EVENTS.ICE_CANDIDATE, {
                    room: this.roomId,
                    candidate: event.candidate
                });
            }
        };

        // Handle remote stream
        this.peerConnection.ontrack = (event) => {
            this.remoteStream = event.streams[0];
            if (this.onRemoteStream) {
                this.onRemoteStream(this.remoteStream);
            }
        };

        // Handle connection state changes
        this.peerConnection.onconnectionstatechange = () => {
            const state = this.peerConnection.connectionState;
            this.isConnected = (state === 'connected');

            if (this.onConnectionStateChange) {
                this.onConnectionStateChange(state);
            }

            if (state === 'connected') {
                this.reconnectAttempts = 0;
                this.startStatsMonitor();
            } else if (state === 'disconnected' || state === 'failed') {
                this.stopStatsMonitor();
            }
        };

        // Handle ICE connection state
        this.peerConnection.oniceconnectionstatechange = () => {
            const state = this.peerConnection.iceConnectionState;
            if (state === 'failed') {
                this.peerConnection.restartIce();
            }
        };

        // Setup data channel for low-latency control messages
        if (this.role === 'mobile') {
            this.dataChannel = this.peerConnection.createDataChannel('controls', {
                ordered: true
            });
            this.setupDataChannel(this.dataChannel);
        } else {
            this.peerConnection.ondatachannel = (event) => {
                this.dataChannel = event.channel;
                this.setupDataChannel(this.dataChannel);
            };
        }

        // Setup socket signaling listeners
        this.setupSignaling();

        return this.peerConnection;
    }

    /**
     * Setup data channel event handlers
     */
    setupDataChannel(channel) {
        channel.onopen = () => {
            console.log('📡 Data channel opened');
        };

        channel.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                if (this.onDataChannel) {
                    this.onDataChannel(message);
                }
            } catch (e) {
                console.error('Data channel parse error:', e);
            }
        };

        channel.onclose = () => {
            console.log('📡 Data channel closed');
        };
    }

    /**
     * Send message via data channel
     */
    sendData(type, data) {
        if (this.dataChannel && this.dataChannel.readyState === 'open') {
            this.dataChannel.send(JSON.stringify({ type, data }));
        }
    }

    /**
     * Setup WebRTC signaling via Socket.IO
     */
    setupSignaling() {
        // Receive offer
        this.socket.on(PHONECAM.EVENTS.OFFER, async (data) => {
            try {
                await this.peerConnection.setRemoteDescription(
                    new RTCSessionDescription(data.sdp)
                );
                const answer = await this.peerConnection.createAnswer();
                await this.peerConnection.setLocalDescription(answer);
                this.socket.emit(PHONECAM.EVENTS.ANSWER, {
                    room: this.roomId,
                    sdp: answer
                });
            } catch (e) {
                console.error('Error handling offer:', e);
            }
        });

        // Receive answer
        this.socket.on(PHONECAM.EVENTS.ANSWER, async (data) => {
            try {
                await this.peerConnection.setRemoteDescription(
                    new RTCSessionDescription(data.sdp)
                );
            } catch (e) {
                console.error('Error handling answer:', e);
            }
        });

        // Receive ICE candidate
        this.socket.on(PHONECAM.EVENTS.ICE_CANDIDATE, async (data) => {
            try {
                if (data.candidate) {
                    await this.peerConnection.addIceCandidate(
                        new RTCIceCandidate(data.candidate)
                    );
                }
            } catch (e) {
                console.error('Error adding ICE candidate:', e);
            }
        });
    }

    /**
     * Add local media stream and create offer
     */
    async addStreamAndOffer(stream) {
        this.localStream = stream;

        stream.getTracks().forEach(track => {
            this.peerConnection.addTrack(track, stream);
        });

        // Set encoding parameters for high quality
        const senders = this.peerConnection.getSenders();
        for (const sender of senders) {
            if (sender.track && sender.track.kind === 'video') {
                const params = sender.getParameters();
                if (!params.encodings) params.encodings = [{}];
                params.encodings[0].maxBitrate = PHONECAM.BITRATE.ultra * 1000;
                params.encodings[0].maxFramerate = 60;
                await sender.setParameters(params);
            }
        }

        const offer = await this.peerConnection.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
        });
        await this.peerConnection.setLocalDescription(offer);

        this.socket.emit(PHONECAM.EVENTS.OFFER, {
            room: this.roomId,
            sdp: offer
        });
    }

    /**
     * Replace video track (e.g., when switching cameras)
     */
    async replaceVideoTrack(newTrack) {
        const sender = this.peerConnection.getSenders().find(
            s => s.track && s.track.kind === 'video'
        );
        if (sender) {
            await sender.replaceTrack(newTrack);
        }
    }

    /**
     * Replace audio track
     */
    async replaceAudioTrack(newTrack) {
        const sender = this.peerConnection.getSenders().find(
            s => s.track && s.track.kind === 'audio'
        );
        if (sender) {
            await sender.replaceTrack(newTrack);
        }
    }

    /**
     * Start monitoring connection statistics
     */
    startStatsMonitor() {
        this.stopStatsMonitor();
        this.statsInterval = setInterval(async () => {
            if (!this.peerConnection) return;
            try {
                const stats = await this.peerConnection.getStats();
                const report = this.parseStats(stats);
                if (this.onStats) {
                    this.onStats(report);
                }
            } catch (e) {
                // Connection might be closing
            }
        }, 1000);
    }

    /**
     * Stop stats monitoring
     */
    stopStatsMonitor() {
        if (this.statsInterval) {
            clearInterval(this.statsInterval);
            this.statsInterval = null;
        }
    }

    /**
     * Parse WebRTC stats into readable format
     */
    parseStats(stats) {
        const report = {
            video: { bytesSent: 0, bytesReceived: 0, fps: 0, width: 0, height: 0, bitrate: 0 },
            audio: { bytesSent: 0, bytesReceived: 0 },
            connection: { rtt: 0, jitter: 0, packetsLost: 0, candidateType: '' }
        };

        stats.forEach(stat => {
            if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
                report.video.bytesReceived = stat.bytesReceived || 0;
                report.video.fps = stat.framesPerSecond || 0;
                report.video.width = stat.frameWidth || 0;
                report.video.height = stat.frameHeight || 0;
                report.video.packetsLost = stat.packetsLost || 0;
                report.video.jitter = stat.jitter || 0;
            }
            if (stat.type === 'outbound-rtp' && stat.kind === 'video') {
                report.video.bytesSent = stat.bytesSent || 0;
                report.video.fps = stat.framesPerSecond || 0;
                report.video.width = stat.frameWidth || 0;
                report.video.height = stat.frameHeight || 0;
            }
            if (stat.type === 'candidate-pair' && stat.state === 'succeeded') {
                report.connection.rtt = stat.currentRoundTripTime
                    ? (stat.currentRoundTripTime * 1000).toFixed(0)
                    : 0;
            }
            if (stat.type === 'remote-candidate') {
                report.connection.candidateType = stat.candidateType || '';
            }
        });

        // Calculate bitrate
        if (!this._lastBytesReceived) this._lastBytesReceived = 0;
        if (!this._lastBytesSent) this._lastBytesSent = 0;

        const bytesNow = report.video.bytesReceived || report.video.bytesSent;
        const bytesLast = this._lastBytesReceived || this._lastBytesSent;
        report.video.bitrate = ((bytesNow - bytesLast) * 8 / 1000).toFixed(0); // kbps

        this._lastBytesReceived = report.video.bytesReceived;
        this._lastBytesSent = report.video.bytesSent;

        return report;
    }

    /**
     * Close connection and cleanup
     */
    close() {
        this.stopStatsMonitor();
        if (this.dataChannel) {
            this.dataChannel.close();
        }
        if (this.peerConnection) {
            this.peerConnection.close();
        }
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
        }
        this.peerConnection = null;
        this.localStream = null;
        this.remoteStream = null;
        this.dataChannel = null;
    }
}
