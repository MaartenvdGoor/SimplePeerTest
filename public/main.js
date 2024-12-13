import {
    GestureRecognizer,
    FilesetResolver
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3";

const socket = io();
let currentVideoStream; // The currently active stream (either webcam or screen sharing)
let localStream; // The webcam stream
let peers = {}; // Store peers
let audioMuted = false;
let videoMuted = false;
let thumbsUp = false;

const joinContainer = document.getElementById('join-container');
const videoContainer = document.getElementById('video-container');
const roomInput = document.getElementById('roomInput');
const joinButton = document.getElementById('joinButton');
const localVideo = document.getElementById('localVideo');
const remoteVideos = document.getElementById('remoteVideos');
const muteAudioButton = document.getElementById('muteAudioButton');
const muteVideoButton = document.getElementById('muteVideoButton');
const shareScreenButton = document.getElementById('shareScreenButton');

let gestureRecognizer = null
let webcamRunning = false;

joinButton.addEventListener('click', () => {
    const roomName = roomInput.value;
    if (roomName) {
        socket.emit('join-room', roomName);
        joinContainer.style.display = 'none';
        videoContainer.style.display = 'flex';
        initializePeer();
    }
});

muteAudioButton.addEventListener('click', () => {
    audioMuted = !audioMuted;
    localStream.getAudioTracks()[0].enabled = !audioMuted;
    muteAudioButton.textContent = audioMuted ? 'Unmute Audio' : 'Mute Audio';
});

muteVideoButton.addEventListener('click', () => {
    videoMuted = !videoMuted;
    localStream.getVideoTracks()[0].enabled = !videoMuted;
    muteVideoButton.textContent = videoMuted ? 'Unmute Video' : 'Mute Video';
});

function initializePeer(isInitiator = false, peerId) {
    return new Promise((resolve, reject) => {
        if (!localStream) {
            navigator.mediaDevices.getUserMedia({video: {
                    width: {
                        ideal: 640
                    },
                    height: {
                        ideal: 360
                    },
                    frameRate: 20,
                    aspectRatio: {
                        exact: 640 / 360,
                    },
                }, audio: true})
                .then(stream => {
                    console.log(stream.getVideoTracks())
                    localVideo.srcObject = stream;
                    localStream = stream;
                    currentVideoStream = localStream; // Initialize with webcam stream
                    localVideo.addEventListener("loadeddata", predictWebcam)
                    webcamRunning = true
                    createPeer(isInitiator, peerId, stream, resolve);
                })
                .catch(error => {
                    console.error('Error accessing media devices:', error);
                    alert('Could not access your camera and microphone.');
                    reject(error);
                });
        } else {
            createPeer(isInitiator, peerId, currentVideoStream, resolve); // Use the active stream
        }
    });
}

function createPeer(isInitiator, peerId, stream, resolve) {
    const peer = new SimplePeer({
        initiator: isInitiator,
        trickle: false,
        stream: stream
    });

    peer.on('signal', data => {
        socket.emit('signal', {peerId, data});
    });

    peer.on('stream', stream => {
        addRemoteStream(stream, peerId);
    });

    peer.on('data', data => {
        console.log('Received message:', data.toString());
    });

    peer.on('error', err => {
        console.error('Peer error:', err);
    });

    peers[peerId] = peer;
    resolve(peer);
}

socket.on('connect', () => {
    console.log('Connected to signaling server');
});

socket.on('signal', async ({peerId, data}) => {
    if (!peers[peerId]) {
        try {
            await initializePeer(false, peerId);
        } catch (err) {
            console.error('Failed to initialize peer:', err);
            return;
        }
    }
    peers[peerId].signal(data);
});

socket.on('joined-room', async ({peerId}) => {
    console.log('Peer joined room:', peerId);

    if (!peers[peerId]) {
        try {
            await initializePeer(true, peerId);
        } catch (err) {
            console.error('Failed to initialize peer for new joiner:', err);
        }
    }
});

socket.on('peer-disconnected', peerId => {
    const videoElement = document.getElementById(`video-${peerId}`);
    if (videoElement) {
        videoElement.remove();
    }
    delete peers[peerId];
});

socket.on('thumbs_up', peerId => {
    const videoElement = document.getElementById(`video-${peerId}`);
    if (videoElement) {
        videoElement.style.border = "5px solid red";
    }
});

socket.on('clear_gesture', peerId => {
    const videoElement = document.getElementById(`video-${peerId}`);
    if (videoElement) {
        videoElement.style.border = ""
    }
})

function addRemoteStream(stream, peerId) {
    const videoElement = document.createElement('video');
    videoElement.id = `video-${peerId}`;
    videoElement.srcObject = stream;
    videoElement.autoplay = true;
    remoteVideos.appendChild(videoElement);
}

shareScreenButton.addEventListener('click', () => {
    const screenPeerIds = Object.keys(peers);
    if (screenPeerIds.length === 0) {
        console.error('No active peers for screen sharing.');
        return;
    }

    navigator.mediaDevices.getDisplayMedia({video: true})
        .then(screenStream => {
            currentVideoStream = screenStream; // Update to the screen-sharing stream

            // Replace video track for each peer
            screenPeerIds.forEach(peerId => {
                const peer = peers[peerId];
                if (!peer) {
                    console.warn(`Peer with ID ${peerId} not found.`);
                    return;
                }
                peer.replaceTrack(localStream.getVideoTracks()[0], screenStream.getVideoTracks()[0], localStream);
            });

            // Update the local video preview to show the screen stream
            localVideo.srcObject = screenStream;

            screenStream.getVideoTracks()[0].addEventListener('ended', () => {
                currentVideoStream = localStream; // Revert back to webcam stream

                // Revert track replacement for each peer
                screenPeerIds.forEach(peerId => {
                    const peer = peers[peerId];
                    if (!peer) return;

                    peer.replaceTrack(screenStream.getVideoTracks()[0], localStream.getVideoTracks()[0], localStream);
                });

                localVideo.srcObject = localStream; // Revert to the original webcam stream
            });
        })
        .catch(error => {
            console.error('Error sharing screen:', error);
        });
});


const createGestureRecognizer = async () => {
    const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
    );
    gestureRecognizer = await GestureRecognizer.createFromOptions(vision, {
        baseOptions: {
            modelAssetPath:
                "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
            delegate: "GPU"
        },
        runningMode: "VIDEO"
    });
};

createGestureRecognizer()

let lastVideoTime = -1;
let results = undefined;

async function predictWebcam() {
    let nowInMs = Date.now();
    if (localVideo.currentTime !== lastVideoTime) {
        lastVideoTime = localVideo.currentTime;
        results = gestureRecognizer.recognizeForVideo(localVideo, nowInMs);
        if (results.gestures.length > 0){
            if (results.gestures[0][0].categoryName === "Thumb_Up"  && !thumbsUp){
                thumbsUp = true
                socket.emit('thumbsUp',{});
                console.log(thumbsUp)
                localVideo.style.border = "5px solid red";
            }
            else if(results.gestures[0][0].categoryName === "None" && thumbsUp){
                thumbsUp = false
                socket.emit('clearGesture')
                localVideo.style.border = "";
                console.log(thumbsUp)
            }
        }
        else if(thumbsUp){
            thumbsUp = false
            socket.emit('clearGesture')
            localVideo.style.border = "";
            console.log(thumbsUp)
        }


    }

    // Call this function again to keep predicting when the browser is ready.
    if (webcamRunning === true) {
        window.requestAnimationFrame(predictWebcam);
    }
}