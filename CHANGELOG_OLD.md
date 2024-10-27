# Older changes
## 1.0.0 (2023-10-01)

- (o0shojo0o) Increase to the first major release, as it has now reached a stable level. 
- (o0shojo0o) added yieldtotal Protection against incorrect zeroing when the OpenDTU restarts if the inverter is not accessible
- (o0shojo0o) added option `Set the states to 0 if the inverter is not accessible.` ([#97](https://github.com/o0shojo0o/ioBroker.opendtu/issues/97))

## 0.1.8 (2023-09-22)

- (o0shojo0o) added option `Protect self-set names from being overwritten by the adapter` ([#76](https://github.com/o0shojo0o/ioBroker.opendtu/issues/76))
- (o0shojo0o) allow multiple AdminTabs for multiple instances ([#88](https://github.com/o0shojo0o/ioBroker.opendtu/issues/88))
- (o0shojo0o) fixed password with special characters ([#35](https://github.com/o0shojo0o/ioBroker.opendtu/issues/35))
- (o0shojo0o) fixed incorrect handling of zeroing of `yield*` data points by OpenDTU ([#96](https://github.com/o0shojo0o/ioBroker.opendtu/issues/96))
- (o0shojo0o) remove zeroing of `yield*` data points by this adapter ([#96](https://github.com/o0shojo0o/ioBroker.opendtu/issues/96))

## 0.1.7 (2023-06-30)

- (o0shojo0o) workaround for incorrectly used button data point

## 0.1.6 (2023-06-30)

- (o0shojo0o) fixed power control (power_off)

## 0.1.5 (2023-05-15)

- (o0shojo0o) code optimizations

## 0.1.4 (2023-03-23)

- (o0shojo0o) fixed power control `on`, `off`, `restart`
- (o0shojo0o) support for password protected liveview
- (o0shojo0o) other small fixes

## 0.1.2 (2023-03-03)

- (o0shojo0o) fixed yield* values

## 0.1.1 (2023-02-24)

- (o0shojo0o) state rolls corrected
- (o0shojo0o) add DTU datapoint `rssi` and `ip`
- (o0shojo0o) repeated writing of the yieldtotal set to 00:01:00. (is necessary for e.g. sourceanalytix)

## 0.1.0 (2023-02-17)

- (o0shojo0o) initial release