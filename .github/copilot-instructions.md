# ioBroker Adapter Development with GitHub Copilot

**Version:** 0.4.0
**Template Source:** https://github.com/DrozmotiX/ioBroker-Copilot-Instructions

This file contains instructions and best practices for GitHub Copilot when working on ioBroker adapter development.

## Project Context

You are working on an ioBroker adapter. ioBroker is an integration platform for the Internet of Things, focused on building smart home and industrial IoT solutions. Adapters are plugins that connect ioBroker to external systems, devices, or services.

**OpenDTU Adapter Specifics:**
- **Adapter Name:** opendtu
- **Purpose:** Connects ioBroker to OpenDTU hardware for solar inverter monitoring and control
- **Target Device:** OpenDTU - Open source hardware for solar inverter communication
- **Primary Functions:** 
  - Real-time monitoring of solar inverter data (power output, voltage, current, yield)
  - Inverter control (power limits, restart commands)
  - Historical data collection and processing
- **Communication:** HTTP REST API and WebSocket connections to OpenDTU web interface
- **Key Dependencies:** axios (HTTP requests), ws (WebSocket), node-schedule (polling intervals)
- **Configuration Requirements:** 
  - OpenDTU IP address and port
  - WebUI credentials (admin/password)
  - Connection security settings (HTTP/HTTPS)

## Testing

### Unit Testing
- Use Jest as the primary testing framework for ioBroker adapters
- Create tests in the `test/` directory
- Test files should have `.test.js` extension
- Mock external dependencies like axios for HTTP requests and WebSocket connections
- Test adapter lifecycle methods: `onReady()`, `onStateChange()`, `onUnload()`
- Verify proper error handling for network failures and invalid responses

### Integration Testing
- Test actual communication with OpenDTU hardware when available
- Verify WebSocket connection establishment and data processing
- Test configuration validation and error scenarios
- Ensure proper cleanup of resources (WebSocket connections, scheduled jobs)

### Test Coverage Areas
- HTTP API communication (`getDTUData()`, `setInverterLimit()`, `setInverterPower()`)
- WebSocket message processing (`processMessage()`)
- State management and object creation
- Error handling and recovery mechanisms
- Configuration validation

## Code Structure

### Main Adapter Class
- Extends `utils.Adapter` from `@iobroker/adapter-core`
- Implements standard lifecycle methods
- Handles WebSocket and HTTP communication
- Manages polling schedules using `node-schedule`

### Key Methods to Understand
- `onReady()` - Initializes connections and starts data collection
- `onStateChange()` - Handles control commands from ioBroker
- `processMessage()` - Processes incoming WebSocket data
- `getDTUData()` - Fetches system status via HTTP API
- `setInverterLimit()`, `setInverterPower()` - Inverter control functions

### Library Structure
- `lib/websocketController.js` - WebSocket connection management
- `lib/dataController.js` - Data processing and state management
- `lib/stateDefinition.js` - Object and state definitions

## Development Standards

### ioBroker Specific Patterns

#### State Management
```javascript
// Always check if state exists before setting
await this.setStateAsync('device.state', value, true);

// Use proper state definitions with correct types
await this.setObjectNotExistsAsync('device.power', {
    type: 'state',
    common: {
        name: 'Current Power',
        type: 'number',
        role: 'value.power',
        unit: 'W',
        read: true,
        write: false
    },
    native: {}
});
```

#### Logging
```javascript
// Use appropriate log levels
this.log.error('Connection failed: ' + error.message);
this.log.warn('Inverter offline, setting states to zero');
this.log.info('Successfully connected to OpenDTU');
this.log.debug('Received WebSocket message: ' + JSON.stringify(data));
```

#### Configuration Validation
```javascript
// Always validate critical configuration
if (!this.config.webUIServer) {
    this.log.error('OpenDTU server address not configured');
    return;
}

if (!this.config.password) {
    this.log.error('WebUI password is required for inverter control');
    return;
}
```

### Error Handling
- Always implement try-catch blocks for async operations
- Handle network timeouts and connection failures gracefully
- Provide meaningful error messages for troubleshooting
- Implement retry logic for transient failures
- Clean up resources properly in error scenarios

```javascript
try {
    const response = await axios.get(dtuApiURL, { timeout: 10000 });
    // Process response
} catch (error) {
    this.log.error('Failed to fetch DTU data: ' + error.message);
    if (error.code === 'ECONNREFUSED') {
        this.log.warn('OpenDTU not reachable - check IP address and port');
    }
}
```

### WebSocket Handling
- Implement proper connection lifecycle management
- Handle reconnection logic for dropped connections  
- Process incoming messages asynchronously
- Validate message structure before processing
- Implement heartbeat/ping mechanisms if needed

### HTTP API Best Practices
- Use proper authentication headers
- Implement request timeouts
- Handle different HTTP status codes appropriately
- Use axios interceptors for common error handling
- Implement rate limiting to avoid overwhelming OpenDTU

## OpenDTU Integration Specifics

### API Endpoints
- `/api/system/status` - System information and status
- `/api/network/status` - Network configuration
- `/api/limit/config` - Power limit configuration  
- `/api/power/config` - Power control configuration
- WebSocket endpoint for real-time data streaming

### Data Processing
- Handle both REST API responses and WebSocket messages
- Convert units appropriately (W, kW, V, A)
- Calculate derived values (efficiency, daily yield)
- Implement data validation for sensor readings
- Handle inverter offline/online state transitions

### Control Operations
- Implement proper authentication for control commands
- Validate control parameters before sending
- Handle command acknowledgments and errors
- Implement safety checks for power limits
- Provide feedback on control operation success/failure

## Common Patterns

### Async/Await Usage
```javascript
// Prefer async/await over promises
async onReady() {
    try {
        await this.setupObjects();
        await this.startDataCollection();
        this.log.info('Adapter started successfully');
    } catch (error) {
        this.log.error('Startup failed: ' + error.message);
    }
}
```

### Resource Cleanup
```javascript
async onUnload(callback) {
    try {
        // Cancel scheduled jobs
        if (this.pollJob) {
            this.pollJob.cancel();
        }
        
        // Close WebSocket connections
        if (websocketController) {
            await websocketController.disconnect();
        }
        
        callback();
    } catch (error) {
        callback();
    }
}
```

### State Change Handling
```javascript
async onStateChange(id, state) {
    if (state && !state.ack) {
        // Handle user commands
        const parts = id.split('.');
        const command = parts[parts.length - 1];
        
        try {
            await this.handleControlCommand(command, state.val);
            await this.setStateAsync(id, state.val, true);
        } catch (error) {
            this.log.error('Control command failed: ' + error.message);
        }
    }
}
```

## Performance Considerations

### Polling Optimization
- Use reasonable polling intervals to avoid overloading OpenDTU
- Implement different polling rates for different data types
- Consider using WebSocket for real-time data when available
- Implement backoff strategies during errors

### Memory Management
- Avoid memory leaks in long-running operations
- Clean up event listeners and timers properly  
- Use proper data structures for caching
- Monitor memory usage during development

### Network Efficiency
- Batch multiple API calls when possible
- Implement caching for configuration data
- Use compression for WebSocket data if available
- Minimize unnecessary network requests

## Security Considerations

### Credential Handling
- Store passwords in encrypted native configuration
- Never log sensitive information
- Use proper authentication headers
- Implement secure WebSocket connections when available

### Input Validation
- Validate all user inputs and configuration values
- Sanitize data from external sources
- Implement bounds checking for numerical values
- Handle malformed responses gracefully

### Network Security
- Support both HTTP and HTTPS connections
- Validate SSL certificates when using HTTPS
- Implement proper timeout and retry logic
- Consider security implications of local network access

## Debugging and Troubleshooting

### Common Issues
- Connection failures to OpenDTU hardware
- WebSocket disconnections and reconnection logic
- Data parsing errors from API responses
- Authentication failures with WebUI credentials
- State synchronization issues between ioBroker and OpenDTU

### Debugging Tools
- Use adapter debug mode for detailed logging
- Monitor network traffic to identify API issues
- Check OpenDTU logs for server-side problems
- Use ioBroker object browser to verify state creation
- Implement health checks for connection status

### Logging Best Practices
- Log connection establishment and failures
- Log all control commands and their results  
- Debug log raw API responses when troubleshooting
- Use structured logging for better analysis
- Avoid logging sensitive information like passwords

Remember: When working with this OpenDTU adapter, focus on reliability and proper error handling since it deals with real-time monitoring of solar energy systems where data accuracy and availability are critical.