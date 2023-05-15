![Logo](admin/opendtu.png)
# ioBroker.opendtu

[![NPM version](https://img.shields.io/npm/v/iobroker.opendtu.svg)](https://www.npmjs.com/package/iobroker.opendtu)
[![Downloads](https://img.shields.io/npm/dm/iobroker.opendtu.svg)](https://www.npmjs.com/package/iobroker.opendtu)
![Number of Installations](https://iobroker.live/badges/opendtu-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/opendtu-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.opendtu.png?downloads=true)](https://nodei.co/npm/iobroker.opendtu/)

**Tests:** ![Test and Release](https://github.com/o0shojo0o/ioBroker.opendtu/workflows/Test%20and%20Release/badge.svg) [![CodeQL](https://github.com/o0shojo0o/ioBroker.opendtu/actions/workflows/codeql.yml/badge.svg)](https://github.com/o0shojo0o/ioBroker.opendtu/actions/workflows/codeql.yml)

## opendtu adapter for ioBroker

This adapter makes the data points from the project [OpenDTU](https://github.com/tbnobody/OpenDTU) available in real time.  
In addition, the following data points can be used via the adapter to the power limitation of the OpenDTU can be controlled.

```
- opendtu.0.xxxxxx.power_control.limit_nonpersistent_absolute
- opendtu.0.xxxxxx.power_control.limit_nonpersistent_relative
- opendtu.0.xxxxxx.power_control.limit_persistent_absolute
- opendtu.0.xxxxxx.power_control.limit_persistent_relative  
```
For more information on the data points, see their description or click [here](https://github.com/tbnobody/OpenDTU/blob/master/docs/MQTT_Topics.md#inverter-limit-specific-topics).

## Configuration

1. Create a new instance of the adapter
2. Fill in Scheme *(default http)*, WebUi-Address and WebUi-port *(default 80)* of the [OpenDTU](https://github.com/tbnobody/OpenDTU) hardware 
3. Set the WebUi-Passwort **(this is mandatory, if it is incorrect no limit can be set!)**
4. Save the settings

## Changelog
<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->
### 0.1.5 (2023-05-15)

- (o0shojo0o) code optimizations

### 0.1.4 (2023-03-23)

- (o0shojo0o) fix power control `on`, `off`, `restart`
- (o0shojo0o) support for password protected liveview
- (o0shojo0o) other small fixes

### 0.1.2 (2023-03-03)

- (o0shojo0o) fix yield* values

### 0.1.1 (2023-02-24)

- (o0shojo0o) state rolls corrected
- (o0shojo0o) add DTU datapoint `rssi` and `ip`
- (o0shojo0o) repeated writing of the yieldtotal set to 00:01:00. (is necessary for e.g. sourceanalytix)

### 0.1.0 (2023-02-17)

- (o0shojo0o) initial release

## License
MIT License

Copyright (c) 2023 Dennis Rathjen <dennis.rathjen@outlook.de>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
