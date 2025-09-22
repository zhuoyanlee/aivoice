const WebSocket = require('ws');

const ws = new WebSocket('wss://twilio.beanit-alex-lee.workers.dev/media-stream');

ws.on('open', function open() {
  console.log('Connected to WebSocket');
  
  // Send start message
  ws.send(JSON.stringify({
    event: "start",
    start: {
      streamSid: "MZ123456789abcdef",
      callSid: "CAabcdef1234567890",
      tracks: ["inbound"],
      mediaFormat: {
        encoding: "audio/x-mulaw",
        sampleRate: 8000,
        channels: 1
      }
    }
  }));
  
  // Send dummy media data after 1 second
  setTimeout(() => {
    ws.send(JSON.stringify({
        "event": "media",
        "sequenceNumber": "3",
        "media": {
          "track": "inbound",
          "chunk": "2",
          "timestamp": "165",
          "payload": "0dHQzdDR0M3Qz9DR0c/QzdHQ0NDN0dDQzdDN0dHQzdDR0M3QzdHP0NHQz9DN0dDQzdDN0dHQzdDR0M3QzdHP0NHQz9DN0dDQzdDN0dHQzdDR0M3QzdHP0NHQz9DN0dDQzdDN0dHQzdDR0M3QzdHP0NHQz9DN0dDQzdDN0dHQzdDR0M3QzdHP0NHQz9DN0dDQzdDN0dHQzdDR0M3QzdHP0NHQz9DN0dDQzdDN0dHQzdDR0M3QzdHP0NHQz9DN0dDQzdDN0dHQzdDR0M3QzdHP0NHQz9DN0dDQzdDN0dHQzdDR0M3QzdHP0NHQz9DN0dDQzdDN0dHQzdDR0M3QzdHP0NHQz9DN0dDQzdDN0dHQzdDR0M3QzdHP0NHQz9DN0dDQzdDN0dHQzdDR0M3QzdHP0NHQz9DN0dDQzdDN0dHQzdDR0M3QzdHP0NHQz9DN0dDQzdDN0dHQzdDR0M3QzdHP0NHQz9DN0dDQzdDN0dHQzdDR0M3QzdHP0NHQz9DN0dDQzdDN0dHQzdDR0M3QzdHP0NHQz9DN0dDQzdDN0dHQzdDR0M3QzdHP0NHQz9DN0dDQzdDN0dHQzdDR0M3QzdHP0NHQz9DN0dDQzdDN0dHQzdDR0M3QzdHP0NHQz9DN0dDQzdDN0dHQzdDR0M3QzdHP0NHQz9DN0dDQzdDN0dHQzdDR0M3QzdHP0NHQz9DN0dDQzdDN0dHQzdDR0M3QzdHP0NHQz9DN0dDQzdDN0dHQ"
        },
        "streamSid": "MZ1234567890abcdef1234567890abcdef"
      }));
  }, 1000);
  
  
  // Send dummy media data after 1 second
  setTimeout(() => {
    ws.send(JSON.stringify({
        "event": "media",
        "sequenceNumber": "4",
        "media": {
          "track": "inbound",
          "chunk": "3",
          "timestamp": "325",
          "payload": "pqaioaOlpaWmpaOjoKajo6alo6Ojo6OkpKSko6KjpKOkpKOjoqOjpKOkpKOjoqOjo6SjpKSjo6Kjo6Oko6SjpKOio6OjpKOkpKSjo6Ojo6OkpKSko6KjpKOko6OjoqOjpKOkpKOjoqOjo6OkpKSko6Kjo6Oko6SjpKOio6OjpKOkpKSjo6Kjo6OkpKSjo6Kjo6Oko6SjpKOio6OjpKOkpKSjo6Kjo6OkpKSko6Kjo6Oko6SjpKOio6OjpKOkpKSjo6Kjo6OkpKSko6Kjo6Oko6OjpKOio6OjpKOkpKSjo6Kjo6OkpKSko6Kjo6Oko6SjpKOio6OjpKOkpKSjo6Kjo6OkpKSko6Kjo6Oko6SjpKOio6OjpKOkpKSjo6Kjo6OkpKSko6Kjo6Oko6SjpKOio6OjpKOkpKSjo6Kjo6OkpKSko6Kjo6Oko6SjpKOio6OjpKOkpKSjo6Kjo6OkpKSko6Kjo6Oko6SjpKOio6OjpKOkpKSjo6Kjo6OkpKSko6Kjo6Oko6SjpKOio6OjpKOkpKSjo6Kjo6OkpKSko6Kjo6Oko6SjpKOio6OjpKOkpKSjo6Kjo6OkpKSko6Kjo6Oko6SjpKOio6OjpKOkpKSjo6Kjo6OkpKSko6Kjo6Oko6SjpKOio6OjpKOkpKSjo6Kjo6OkpKSko6Kjo6Oko6SjpKOio6OjpKOkpKSjo6Kj"
        },
        "streamSid": "MZ1234567890abcdef1234567890abcdef"
      }));
  }, 1000);
  

  // Send stop message after 5 seconds
  setTimeout(() => {
    ws.send(JSON.stringify({
      event: "stop",
      streamSid: "MZ123456789abcdef"
    }));
  }, 5000);
});

ws.on('message', function message(data) {
  console.log('Received:', data.toString());
});

ws.on('close', function close() {
  console.log('Disconnected from WebSocket');
});

ws.on('error', function error(err) {
  console.error('WebSocket error:', err);
});
