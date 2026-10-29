![Logo](../../admin/opendtu.png)
# ioBroker.opendtu – Anleitung

**🇬🇧 [English version](../../README.md)**

## Was macht der Adapter?

[OpenDTU](https://www.opendtu.solar) ist eine kleine Box, die per Funk mit Hoymiles-Mikrowechselrichtern spricht – oft bei Balkonkraftwerken im Einsatz.
Der Adapter holt die Werte deiner OpenDTU live in den ioBroker:

- aktuelle Leistung jedes Wechselrichters und aller zusammen
- Ertrag von heute und seit Inbetriebnahme
- Werte pro Solarmodul, Temperatur, Spannung und mehr
- **Leistung begrenzen**, z. B. für eine Nulleinspeisung

## Was du brauchst

- eine laufende OpenDTU in deinem Heimnetz (ihre Webseite lässt sich im Browser öffnen)
- ihre Adresse, z. B. `192.168.1.50`
- das Passwort der OpenDTU-Webseite – nötig zum Begrenzen der Leistung (siehe [Passwort](#passwort))

## Einrichtung

1. Adapter im ioBroker unter **Adapter** installieren und eine Instanz anlegen.
2. In den Einstellungen die **Adresse** der OpenDTU eintragen – dieselbe, die du im Browser eingibst.
3. Das **Passwort** der OpenDTU-Webseite eintragen (Benutzer `admin`).
4. **Speichern**. Nach wenigen Sekunden erscheinen die Werte unter **Objekte → opendtu.0**.

Fertig. Protokoll (HTTP) und Port (80) muss man nur selten ändern – sie sind im Expertenmodus des Admins sichtbar.

### Optionen

| Option | Was sie bewirkt |
|---|---|
| Werte auf 0 setzen, wenn ein Wechselrichter nicht erreichbar ist | Empfohlen. Nachts schalten die Wechselrichter ab. Ohne diese Option bleiben die letzten Werte vom Abend die ganze Nacht stehen. Ertragswerte bleiben erhalten. |
| Eigene Namen der Objekte behalten | Einschalten, wenn du Objekte im ioBroker umbenannt hast. Der Adapter überschreibt die Namen dann nicht mehr. |

### Passwort

- Zum **Lesen** der Werte braucht es kein Passwort, solange in der OpenDTU *„Nur-Lese-Zugriff auf die Weboberfläche ohne Passwort zulassen“* eingeschaltet ist (*Einstellungen → Sicherheit*). Das ist die Grundeinstellung.
- Zum **Begrenzen der Leistung** und zum Ein-/Ausschalten wird das Passwort immer gebraucht.

## Die Werte nutzen

Jeder Wechselrichter bekommt einen eigenen Ordner mit seiner Seriennummer (daneben steht der Name, den du in der OpenDTU vergeben hast).

| Objekt | Bedeutung |
|---|---|
| `opendtu.0.total.power` | aktuelle Leistung aller Wechselrichter zusammen (W) |
| `opendtu.0.total.yieldday` | Ertrag aller Wechselrichter heute (Wh) |
| `opendtu.0.total.yieldtotal` | Ertrag aller Wechselrichter seit Inbetriebnahme (kWh) |
| `opendtu.0.<Seriennummer>.ac.phase_1.power` | aktuelle Leistung dieses Wechselrichters (W) |
| `opendtu.0.<Seriennummer>.yieldday` | Ertrag dieses Wechselrichters heute (Wh) |
| `opendtu.0.<Seriennummer>.yieldtotal` | Ertrag dieses Wechselrichters seit Inbetriebnahme (kWh) |
| `opendtu.0.<Seriennummer>.dc.input_1.power` | Leistung des Solarmoduls an Eingang 1 (W) |
| `opendtu.0.<Seriennummer>.temperature` | Temperatur des Wechselrichters (°C) |
| `opendtu.0.<Seriennummer>.available` | Wechselrichter erreichbar – nachts `false` ist normal |
| `opendtu.0.<Seriennummer>.producing` | Wechselrichter erzeugt Strom |
| `opendtu.0.dtu.available` | die OpenDTU selbst ist erreichbar |

**Tipp für Energiestatistiken:** `yieldtotal` verwenden. Der Wert zählt nur hoch und wird von Neustarts nicht beeinflusst – ideal für Adapter wie *SourceAnalytix* oder eigene Diagramme.

## Leistung begrenzen

Im Ordner `opendtu.0.<Seriennummer>.power_control` lässt sich die Leistung eines Wechselrichters begrenzen. Einfach eine Zahl in eines dieser Objekte schreiben:

| Objekt | Grenze | Bleibt nach Neustart des Wechselrichters? |
|---|---|---|
| `limit_nonpersistent_absolute` | in Watt, z. B. `300` | nein |
| `limit_nonpersistent_relative` | in Prozent, z. B. `50` | nein |
| `limit_persistent_absolute` | in Watt | ja |
| `limit_persistent_relative` | in Prozent | ja |

- Für eine **automatische Regelung** (z. B. Nulleinspeisung, Änderungen alle paar Sekunden oder Minuten) immer die **nonpersistent**-Objekte verwenden.
- ⚠️ Die **persistent**-Grenzen werden im Speicher des Wechselrichters abgelegt, der nur begrenzt oft beschrieben werden kann. Nur **selten** ändern, z. B. einmal bei der Einrichtung.
- Die aktuell gültige Grenze steht in `current_limit_relative` und `current_limit_absolute`. Nach einer Grenze in Watt kann es bis zu etwa 4 Minuten dauern, bis dieser Wert aktualisiert ist.

Beispiel in einem JavaScript-Skript – Wechselrichter auf 300 W begrenzen:

```js
setState('opendtu.0.116100000001.power_control.limit_nonpersistent_absolute', 300);
```

Die Knöpfe `power_on`, `power_off` und `restart` schalten den Wechselrichter ein, aus oder starten ihn neu.

## Fragen und Probleme

**Es erscheinen keine Werte**
- Die Adresse aus den Einstellungen im Browser öffnen. Öffnet sich dort die OpenDTU-Seite nicht, erreicht auch der ioBroker sie nicht (Adresse, WLAN, Firewall oder VLAN prüfen).
- Wenn in der OpenDTU der *„Nur-Lese-Zugriff“* ausgeschaltet ist, das Passwort in den Adapter-Einstellungen eintragen.

**Die Begrenzung wird nicht übernommen**
- Passwort in den Adapter-Einstellungen prüfen – zum Ändern der Grenze ist es immer nötig.
- Ins ioBroker-Log schauen; der Adapter schreibt dort eine Meldung, wenn die OpenDTU den Befehl ablehnt.

**Nachts sind alle Werte 0 / die Wechselrichter „nicht erreichbar“**
- Das ist normal: Hoymiles-Wechselrichter werden von den Solarmodulen versorgt und schalten bei Dunkelheit ab.

**Mein Netzwerk zeigt viele DNS-Anfragen vom ioBroker**
- Die IP-Adresse (z. B. `192.168.1.50`) statt eines Namens wie `opendtu.local` eintragen.

Technische Details zur Funktionsweise stehen in der [englischen Anleitung](../../README.md) unter *For advanced users*.
