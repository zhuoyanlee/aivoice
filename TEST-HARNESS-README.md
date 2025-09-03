# AI Voice Call Router - Test Harness

A comprehensive testing framework for the AI Voice Call Router that allows you to test all components without requiring OnSIP to route actual calls.

## 🎯 Overview

The test harness provides:
- **SIP Call Simulation**: Mock incoming and outgoing calls
- **Audio Processing Tests**: Test speech recognition and synthesis
- **Asterisk Integration**: Simulate Asterisk events and call flows
- **Azure Speech Testing**: Test Azure Speech Services integration
- **Full Integration Tests**: End-to-end testing scenarios
- **Performance Testing**: Load and stress testing capabilities

## 🚀 Quick Start

### 1. Start the Main Application
```bash
npm start
```

### 2. Start the Test Harness
```bash
npm run test:harness
```

### 3. Run Tests (Choose one method)

#### Option A: Interactive Test Client
```bash
npm run test:client
```

#### Option B: Command Line Test Runner
```bash
# Run smoke tests
npm run test:smoke

# Run integration tests
npm run test:integration

# Run full test suite
npm run test:full

# Run performance tests
npm run test:performance
```

## 📁 Test Files

| File | Purpose |
|------|---------|
| `test-harness.js` | Main test harness server |
| `test-client.js` | Interactive test client |
| `test-runner.js` | Command-line test runner |
| `test-config.json` | Test scenarios and configuration |
| `TEST-HARNESS-README.md` | This documentation |

## 🧪 Test Scenarios

### Basic Tests
- **Basic Incoming Call**: Simple call simulation without audio
- **Incoming Call with Audio**: Full call with audio stream processing
- **Outgoing Call**: Test system's ability to make calls

### Audio Processing Tests
- **Speech Recognition**: Test Azure Speech-to-Text
- **Text-to-Speech**: Test Azure Text-to-Speech
- **Conversation Flow**: Full conversation processing

### Integration Tests
- **Asterisk Events**: Test Asterisk event handling
- **Complex Call Flows**: Multi-step call scenarios
- **Error Handling**: Test system behavior under error conditions

### Performance Tests
- **Stress Testing**: Multiple concurrent calls
- **Load Testing**: System performance under load
- **Latency Testing**: Response time measurements

## 🎮 Interactive Test Client

The interactive test client provides a menu-driven interface:

```
🧪 AI Voice Call Router Test Client
=====================================
1. Run incoming call test
2. Run outgoing call test
3. Test audio processing
4. Test Asterisk integration
5. Test Azure Speech services
6. Run full integration test
7. View test results
8. Get system status
9. Exit
```

## 🔧 Configuration

### Test Harness Configuration
Edit `test-config.json` to customize:

```json
{
  "testHarness": {
    "port": 3001,
    "wsPort": 3002,
    "targetApp": "http://localhost:3000",
    "testAudioDir": "./test_audio"
  }
}
```

### Test Scenarios
Add custom test scenarios:

```json
{
  "testScenarios": {
    "my_custom_test": {
      "name": "My Custom Test",
      "description": "Description of what this test does",
      "type": "incoming_call",
      "config": {
        "fromNumber": "+1234567890",
        "duration": 5000
      }
    }
  }
}
```

## 📊 Test Results

### Viewing Results
- **Interactive Client**: Use option 7 to view results
- **Web Interface**: Visit `http://localhost:3001/test/results`
- **Command Line**: Results are displayed after each test run

### Result Format
```json
{
  "id": "test_1234567890_abc123",
  "status": "completed",
  "startTime": 1640995200000,
  "duration": 5000,
  "events": [
    {
      "type": "invite_received",
      "data": { "callId": "test_123" }
    }
  ],
  "results": {
    "success": true,
    "duration": 5000,
    "events": 3
  }
}
```

## 🎵 Audio Testing

### Generated Test Audio
The harness automatically generates test audio files:
- **Speech**: 440Hz sine wave for speech recognition testing
- **Conversation**: Multi-tone audio for conversation testing
- **Silence**: Silent audio for edge case testing
- **Noise**: Background noise simulation

### Custom Audio Files
Place custom audio files in `./test_audio/` directory:
- Supported formats: WAV, MP3
- Recommended: 8kHz, 16-bit, mono for SIP compatibility

## 🔌 API Endpoints

### Test Harness API
- `GET /test/status` - Get test harness status
- `POST /test/start` - Start a test
- `POST /test/stop/:testId` - Stop a test
- `GET /test/results` - Get test results
- `POST /mock/asterisk/events` - Mock Asterisk events

### WebSocket Interface
Connect to `ws://localhost:3002` for real-time test control:
```javascript
const ws = new WebSocket('ws://localhost:3002');
ws.send(JSON.stringify({
  type: 'start_test',
  config: { type: 'incoming_call', fromNumber: '+1234567890' }
}));
```

## 🐛 Troubleshooting

### Common Issues

#### Test Harness Won't Start
- Check if port 3001 is available
- Ensure the main app is running on port 3000
- Check for Node.js version compatibility (>=16.0.0)

#### Tests Fail to Connect
- Verify the main application is running
- Check network connectivity between test harness and main app
- Review environment variables in `.env` file

#### Audio Tests Fail
- Ensure Azure Speech credentials are configured
- Check internet connectivity for Azure services
- Verify audio file permissions in `./test_audio/`

### Debug Mode
Enable debug logging:
```bash
DEBUG=test-harness* npm run test:harness
```

## 📈 Performance Monitoring

### Metrics Tracked
- **Call Duration**: Time from start to end
- **Audio Processing Latency**: Speech recognition/synthesis time
- **Asterisk Response Time**: Event processing speed
- **Memory Usage**: System resource consumption
- **Error Rates**: Failure percentages

### Performance Thresholds
Configured in `test-config.json`:
```json
{
  "assertions": {
    "callDuration": { "min": 1000, "max": 60000 },
    "audioProcessing": { "maxLatency": 2000 },
    "asteriskEvents": { "maxResponseTime": 1000 }
  }
}
```

## 🔄 Continuous Integration

### GitHub Actions Example
```yaml
name: Test Suite
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: '18'
      - run: npm install
      - run: npm start &
      - run: sleep 5
      - run: npm run test:smoke
```

## 📝 Adding New Tests

### 1. Define Test Scenario
Add to `test-config.json`:
```json
{
  "testScenarios": {
    "my_new_test": {
      "name": "My New Test",
      "type": "custom_type",
      "config": { /* test parameters */ }
    }
  }
}
```

### 2. Implement Test Logic
Add test handler in `test-harness.js`:
```javascript
async testCustomType(test) {
  console.log(`Running custom test: ${test.id}`);
  // Your test logic here
  test.status = 'completed';
}
```

### 3. Add to Test Suite
Include in appropriate test suite:
```json
{
  "testSuites": {
    "integration": {
      "scenarios": ["my_new_test"]
    }
  }
}
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Add your test scenarios
4. Update documentation
5. Submit a pull request

## 📄 License

MIT License - see LICENSE file for details.

## 🆘 Support

For issues and questions:
1. Check this documentation
2. Review test logs
3. Open an issue on GitHub
4. Contact the development team

---

**Happy Testing! 🎉**
