const TestHarness = require('./test-harness');
const fs = require('fs');
const path = require('path');

/**
 * Test Runner for AI Voice Call Router
 * Executes test suites programmatically
 */
class TestRunner {
  constructor() {
    this.config = this.loadConfig();
    this.harness = null;
    this.results = [];
  }

  loadConfig() {
    try {
      const configPath = path.join(__dirname, 'test-config.json');
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
      console.error('Failed to load test config:', error);
      process.exit(1);
    }
  }

  async runSuite(suiteName) {
    console.log(`\n🧪 Running test suite: ${suiteName}`);
    console.log('=====================================');

    const suite = this.config.testSuites[suiteName];
    if (!suite) {
      console.error(`❌ Test suite '${suiteName}' not found`);
      return false;
    }

    console.log(`📋 Suite: ${suite.name}`);
    console.log(`📝 Description: ${suite.description}`);
    console.log(`🔢 Scenarios: ${suite.scenarios.length}`);

    // Start test harness
    this.harness = new TestHarness(this.config.testHarness);
    this.harness.start();

    // Wait for harness to be ready
    await this.delay(2000);

    let passed = 0;
    let failed = 0;

    for (const scenarioName of suite.scenarios) {
      const scenario = this.config.testScenarios[scenarioName];
      if (!scenario) {
        console.log(`⚠️  Scenario '${scenarioName}' not found, skipping...`);
        continue;
      }

      console.log(`\n▶️  Running: ${scenario.name}`);
      console.log(`   ${scenario.description}`);

      try {
        const result = await this.runScenario(scenario);
        if (result.success) {
          console.log(`✅ ${scenario.name} - PASSED`);
          passed++;
        } else {
          console.log(`❌ ${scenario.name} - FAILED: ${result.error}`);
          failed++;
        }
      } catch (error) {
        console.log(`❌ ${scenario.name} - ERROR: ${error.message}`);
        failed++;
      }
    }

    // Stop test harness
    this.harness.stop();

    console.log('\n📊 Test Suite Results');
    console.log('=====================');
    console.log(`✅ Passed: ${passed}`);
    console.log(`❌ Failed: ${failed}`);
    console.log(`📈 Success Rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);

    return failed === 0;
  }

  async runScenario(scenario) {
    const testId = `${scenario.name.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}`;
    const testConfig = {
      id: testId,
      ...scenario.config
    };

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ success: false, error: 'Test timeout' });
      }, 30000); // 30 second timeout

      this.harness.once('testComplete', (result) => {
        clearTimeout(timeout);
        resolve(result);
      });

      this.harness.startTest(testConfig);
    });
  }

  async runAllSuites() {
    console.log('\n🚀 Running all test suites');
    console.log('==========================');

    const suites = Object.keys(this.config.testSuites);
    let allPassed = true;

    for (const suiteName of suites) {
      const passed = await this.runSuite(suiteName);
      if (!passed) {
        allPassed = false;
      }
      
      // Wait between suites
      if (suiteName !== suites[suites.length - 1]) {
        console.log('\n⏳ Waiting 5 seconds before next suite...');
        await this.delay(5000);
      }
    }

    console.log('\n🎯 Final Results');
    console.log('================');
    console.log(allPassed ? '🎉 All test suites passed!' : '💥 Some test suites failed!');
    
    return allPassed;
  }

  async runSpecificScenarios(scenarioNames) {
    console.log('\n🎯 Running specific scenarios');
    console.log('=============================');

    this.harness = new TestHarness(this.config.testHarness);
    this.harness.start();

    await this.delay(2000);

    let passed = 0;
    let failed = 0;

    for (const scenarioName of scenarioNames) {
      const scenario = this.config.testScenarios[scenarioName];
      if (!scenario) {
        console.log(`⚠️  Scenario '${scenarioName}' not found, skipping...`);
        continue;
      }

      console.log(`\n▶️  Running: ${scenario.name}`);
      
      try {
        const result = await this.runScenario(scenario);
        if (result.success) {
          console.log(`✅ ${scenario.name} - PASSED`);
          passed++;
        } else {
          console.log(`❌ ${scenario.name} - FAILED: ${result.error}`);
          failed++;
        }
      } catch (error) {
        console.log(`❌ ${scenario.name} - ERROR: ${error.message}`);
        failed++;
      }
    }

    this.harness.stop();

    console.log('\n📊 Scenario Results');
    console.log('===================');
    console.log(`✅ Passed: ${passed}`);
    console.log(`❌ Failed: ${failed}`);

    return failed === 0;
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  showHelp() {
    console.log('\n🧪 AI Voice Call Router Test Runner');
    console.log('====================================');
    console.log('\nUsage:');
    console.log('  node test-runner.js --suite <suite-name>');
    console.log('  node test-runner.js --scenarios <scenario1,scenario2,...>');
    console.log('  node test-runner.js --all');
    console.log('  node test-runner.js --help');
    console.log('\nAvailable test suites:');
    Object.keys(this.config.testSuites).forEach(suite => {
      const suiteConfig = this.config.testSuites[suite];
      console.log(`  ${suite}: ${suiteConfig.description}`);
    });
    console.log('\nAvailable scenarios:');
    Object.keys(this.config.testScenarios).forEach(scenario => {
      const scenarioConfig = this.config.testScenarios[scenario];
      console.log(`  ${scenario}: ${scenarioConfig.description}`);
    });
  }
}

// CLI interface
if (require.main === module) {
  const runner = new TestRunner();
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    runner.showHelp();
    process.exit(0);
  }

  const runTests = async () => {
    try {
      if (args.includes('--all')) {
        await runner.runAllSuites();
      } else if (args.includes('--suite')) {
        const suiteIndex = args.indexOf('--suite');
        const suiteName = args[suiteIndex + 1];
        if (!suiteName) {
          console.error('❌ Please specify a suite name');
          process.exit(1);
        }
        await runner.runSuite(suiteName);
      } else if (args.includes('--scenarios')) {
        const scenariosIndex = args.indexOf('--scenarios');
        const scenariosString = args[scenariosIndex + 1];
        if (!scenariosString) {
          console.error('❌ Please specify scenarios (comma-separated)');
          process.exit(1);
        }
        const scenarioNames = scenariosString.split(',').map(s => s.trim());
        await runner.runSpecificScenarios(scenarioNames);
      } else {
        console.error('❌ Invalid arguments. Use --help for usage information.');
        process.exit(1);
      }
    } catch (error) {
      console.error('❌ Test runner error:', error);
      process.exit(1);
    }
  };

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n🛑 Test runner interrupted');
    if (runner.harness) {
      runner.harness.stop();
    }
    process.exit(0);
  });

  runTests();
}

module.exports = TestRunner;
