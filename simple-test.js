/**
 * Simple Test Script for AI Voice Call Router
 * Tests only the endpoints that currently exist in the main app
 */

const TestHarness = require('./test-harness');
const fetch = require('node-fetch');

async function runSimpleTests() {
  console.log('🧪 AI Voice Call Router - Simple Tests');
  console.log('=====================================\n');

  // Create test harness instance
  const harness = new TestHarness({
    port: 3001,
    targetApp: 'http://localhost:3000'
  });

  // Start the harness
  harness.start();
  console.log('✅ Test harness started');

  // Wait for harness to be ready
  await delay(2000);

  try {
    // Test 1: Health check
    console.log('\n🏥 Test 1: Health Check');
    const healthResponse = await fetch('http://localhost:3000/health');
    const healthData = await healthResponse.json();
    console.log('✅ Health check passed:', healthData);

    // Test 2: Call status
    console.log('\n📞 Test 2: Call Status');
    const callsResponse = await fetch('http://localhost:3000/calls');
    const callsData = await callsResponse.json();
    console.log('✅ Call status retrieved:', callsData);

    // Test 3: Asterisk events
    console.log('\n📡 Test 3: Asterisk Events');
    const asteriskResponse = await fetch('http://localhost:3000/asterisk/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'TestEvent',
        channel: 'SIP/test-1',
        uniqueid: 'test-123'
      })
    });
    const asteriskData = await asteriskResponse.json();
    console.log('✅ Asterisk event sent:', asteriskData);

    // Test 4: Basic incoming call simulation
    console.log('\n📞 Test 4: Incoming Call Simulation');
    await harness.startTest({
      id: 'simple_incoming_1',
      type: 'incoming_call',
      fromNumber: '+1234567890',
      toNumber: '+0987654321',
      duration: 2000,
      withAudio: false
    });
    console.log('✅ Incoming call simulation completed');

    // Test 5: Asterisk integration test
    console.log('\n📡 Test 5: Asterisk Integration');
    await harness.startTest({
      id: 'simple_asterisk_1',
      type: 'asterisk_integration'
    });
    console.log('✅ Asterisk integration test completed');

    // Get test results
    console.log('\n📊 Getting Test Results...');
    const response = await fetch('http://localhost:3001/test/results');
    const results = await response.json();
    
    console.log('\n📋 Test Results Summary:');
    console.log('========================');
    results.results.forEach((result, index) => {
      console.log(`${index + 1}. ${result.id}`);
      console.log(`   Status: ${result.status}`);
      console.log(`   Duration: ${result.results?.duration || 'N/A'}ms`);
      console.log(`   Events: ${result.events?.length || 0}`);
      if (result.error) {
        console.log(`   Error: ${result.error}`);
      }
      if (result.results?.note) {
        console.log(`   Note: ${result.results.note}`);
      }
      console.log('');
    });

    console.log('\n🎉 All simple tests completed successfully!');
    console.log('\n💡 Next steps:');
    console.log('   - Implement audio processing endpoints in main app');
    console.log('   - Add Azure Speech integration endpoints');
    console.log('   - Add outgoing call functionality');
    console.log('   - Run full test suite once endpoints are implemented');

  } catch (error) {
    console.error('❌ Test execution error:', error);
  } finally {
    // Stop the harness
    harness.stop();
    console.log('🛑 Test harness stopped');
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run the simple tests
if (require.main === module) {
  runSimpleTests().catch(console.error);
}

module.exports = { runSimpleTests };
