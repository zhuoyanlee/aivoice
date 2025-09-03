/**
 * Example Test Script for AI Voice Call Router
 * Demonstrates how to use the test harness programmatically
 */

const TestHarness = require('./test-harness');
const fetch = require('node-fetch');

async function runExampleTests() {
  console.log('🧪 AI Voice Call Router - Example Tests');
  console.log('=======================================\n');

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
    // Test 1: Basic incoming call
    console.log('\n📞 Test 1: Basic Incoming Call');
    await harness.startTest({
      id: 'example_incoming_1',
      type: 'incoming_call',
      fromNumber: '+1234567890',
      toNumber: '+0987654321',
      duration: 3000,
      withAudio: false
    });
    console.log('✅ Basic incoming call test completed');

    // Test 2: Audio processing
    console.log('\n🎵 Test 2: Audio Processing');
    await harness.startTest({
      id: 'example_audio_1',
      type: 'audio_processing',
      audioType: 'speech'
    });
    console.log('✅ Audio processing test completed');

    // Test 3: Asterisk integration
    console.log('\n📡 Test 3: Asterisk Integration');
    await harness.startTest({
      id: 'example_asterisk_1',
      type: 'asterisk_integration'
    });
    console.log('✅ Asterisk integration test completed');

    // Test 4: Azure Speech
    console.log('\n🗣️ Test 4: Azure Speech');
    await harness.startTest({
      id: 'example_azure_1',
      type: 'azure_speech'
    });
    console.log('✅ Azure Speech test completed');

    // Test 5: Full integration
    console.log('\n🔄 Test 5: Full Integration');
    await harness.startTest({
      id: 'example_integration_1',
      type: 'full_integration'
    });
    console.log('✅ Full integration test completed');

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
      console.log('');
    });

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

// Run the example tests
if (require.main === module) {
  runExampleTests().catch(console.error);
}

module.exports = { runExampleTests };
