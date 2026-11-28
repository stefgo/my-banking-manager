# Datenbankmodell

Alle Tabellen, Spalten und Beziehungen der Server-Datenbank und die Schlüssel, die sie schützen.
Stand: Schema nach Migration `0018-psd2-account-consents`. Maßgeblich bleibt der Code in
`server/src/db/migrations/`. Wie du die Seite nach einer neuen Migration nachziehst, steht unter
[Diese Seite pflegen](#diese-seite-pflegen).

| | |
| --- | --- |
| Datenbank | SQLite über better-sqlite3-multiple-ciphers |
| Verschlüsselung | die ganze Datei samt WAL, SQLCipher-kompatibel (AES-256 + HMAC) |
| Tabellen | 28, davon `migrations` für Umzug |
| Migrationen | 17 |

## Speicher und Schlüssel

Im Datenverzeichnis liegen drei Dateien: `mbm.db` mit WAL, ganz verschlüsselt; `keystore.json` mit
dem verpackten Datenschlüssel; `blz.json`, das öffentliche BLZ-Verzeichnis, als einzige
unverschlüsselte Datei. Kein Passwort liegt auf der Platte. Was das für den Betrieb heißt, steht
unter [Technische Details](operations.md#verschlüsselung).

![Schlüsselkette: Passwort oder Wiederherstellungsschlüssel packen den Datenschlüssel aus keystore.json aus. Er öffnet mbm.db und liefert den Feldschlüssel für das TOTP-Geheimnis. Bankzugangsdaten versiegelt zusätzlich der Benutzerschlüssel.](assets/diagrams/datenbank-schluessel.svg)

Jedes Benutzerpasswort packt denselben Datenschlüssel aus und öffnet damit die ganze Datenbank.
Bankzugangsdaten sind zusätzlich mit dem Benutzerschlüssel ihres Besitzers versiegelt (blau). Den
öffnen nur dessen Passwort oder dessen Sitzungstoken, also nur während einer Anfrage des Besitzers.
Die versiegelten Spalten unten im Bild liegen selbst wieder in der verschlüsselten `mbm.db`.

- **Datenbank öffnen** (`server/src/db/database.ts`): `cipher = 'sqlcipher'`, `legacy = 4`,
  `key` = Datenschlüssel als Hex. Ein falscher Schlüssel scheitert beim ersten Lesen.
- **Pragmas danach:** `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`,
  `secure_delete = ON` (gelöschte Inhalte werden überschrieben).
- **Versiegelte Felder:** AES-256-GCM. Mit dem Feldschlüssel `v1.iv.tag.daten`
  (`crypto/secrets.ts`); der Benutzerschlüssel mit Passwort `uk1.salt.iv.tag.daten`, mit der
  Benutzer- bzw. Geräte-ID als zusätzlich authentifizierten Daten (`services/userkey.ts`).

## Übersicht

Im Mittelpunkt stehen `accounts` und `transactions`. Links hängen die Konten an den Bankzugängen,
rechts die Kategorien und Regeln an den Buchungen. Oben die Benutzer, unten die Aufträge.

[![Tabellen der MBM-Datenbank, farbig nach Bereich, mit ihren Fremdschlüsseln](assets/diagrams/datenbank-tabellen.svg)](assets/diagrams/datenbank-tabellen.svg)

Klick auf das Bild öffnet es in voller Größe.

- **Farbe des Streifens:** der Bereich, wie in den Abschnitten unten – violett Benutzer und
  Sitzungen, türkis Bankzugänge, blau Konten, grün Buchungen, ocker Kategorien und Regeln, rosa
  Aufträge und Überweisungen, grau eigenständig.
- **Pfeile** zeigen vom Fremdschlüssel zur Tabelle, auf die er verweist, über die naheliegende
  Spalte (`account_id` → `accounts` usw.). Durchgezogen: `ON DELETE CASCADE`; gestrichelt:
  `ON DELETE SET NULL`; orange: ohne Löschregel, das Löschen ist gesperrt; gepunktet: Verweis ohne
  Fremdschlüssel.
- **Im Kasten:** »→ tabelle« ist ein Verweis auf eine entfernte Tabelle, der nicht als Pfeil
  gezeichnet ist; »↺ spalte« ein Verweis auf die eigene Tabelle. Jeder Fremdschlüssel steht mit
  seiner Löschregel in den Tabellen unten.

## Konventionen

| Was | Wie |
| --- | --- |
| Beträge | `INTEGER` in Cent, mit Vorzeichen: negativ ist ein Abgang. Kein Gleitkomma. |
| Daten | `TEXT` als `JJJJ-MM-TT` (Buchungstag, Wertstellung, Termine). |
| Zeitpunkte | `TEXT` als ISO 8601 in UTC, Spalten auf `_at` (`created_at`, `fetched_at` …). |
| Ja / Nein | `INTEGER` 0 oder 1; neuere Spalten mit `CHECK (x IN (0, 1))`. |
| Strukturierte Werte | JSON in `TEXT` (`info_attributes`, `config`, `raw`, `extracts`, `edits`, `previous` …), geprüft mit den Zod-Schemas in `shared`. |
| Leer oder NULL | Neue Textspalten sind `NOT NULL DEFAULT ''`. NULL nur, wo „fehlt“ und „leer“ etwas anderes bedeuten; das steht dann in der Beschreibung. |
| Symbole und Farben | `icon` und `color` sind Namen aus `shared/src/symbols.ts` bzw. der Palette (`violet`, `teal`, `neutral` …), keine Farbwerte. |
| Reihenfolge | `position` ordnet Geschwister in Bäumen und Listen (Gruppen, Konten, Kategorien, Regeln, Karten). |
| Kennungen | `INTEGER PRIMARY KEY`; `transactions` und `import_formats` mit `AUTOINCREMENT`, damit gelöschte Kennungen nie wiederkommen. |

## Tabellen

Nach Bereich geordnet, die Spalten in der Reihenfolge der Datenbank. „Seit“ in der Bedeutung nennt die
Migration, die eine Spalte hinzugefügt hat; ohne diese Angabe stammt sie aus `0001-initial`. In den
Regeln steht `→ tabelle` für einen Fremdschlüssel mit seiner Löschregel.

### Benutzer und Sitzungen

Wer sich anmeldet, mit welchem Gerät, und was jeder für sich eingestellt hat. Konten, Buchungen und Kategorien haben keinen Besitzer: Sie gehören der Instanz. Nur Bankanmeldungen, Lesestatus, Einstellungen und Übersichtskarten sind persönlich.

#### `users`

Ein Benutzer der Instanz. Es gibt keinen Passwort-Hash: Ein Passwort ist richtig, wenn es den Schlüsselplatz des Benutzers in keystore.json öffnet. Der Name steht dort nur als HMAC.

| Spalte | Typ | Regeln | Bedeutung |
| --- | --- | --- | --- |
| `id` | INTEGER | `PK` | Kennung; in keystore.json als userId des Schlüsselplatzes. |
| `name` | TEXT | `NOT NULL` `UNIQUE` `NOCASE` | Anmeldename, Groß- und Kleinschreibung zählen nicht. |
| `totp_secret` | TEXT |  | TOTP-Geheimnis, mit dem Feldschlüssel versiegelt (v1.iv.tag.daten). NULL: kein zweiter Faktor eingerichtet. |
| `totp_last_step` | INTEGER |  | Zuletzt verbrauchter 30-Sekunden-Schritt; derselbe Code gilt nicht zweimal. |
| `created_at` | TEXT | `NOT NULL` | Angelegt (ISO-Zeitpunkt). |
| `last_login_at` | TEXT |  | Letzte Anmeldung. |
| `sealed_user_key` | TEXT |  | Benutzerschlüssel, mit dem Passwort versiegelt (scrypt + AES-256-GCM, Format uk1.salt.iv.tag.daten). Er versiegelt die Bankanmeldungen des Benutzers. |

#### `devices`

Sitzungen: eine Anmeldung im Browser (web) oder ein eingerichtetes Gerät (device). Der Server kennt nur den Hash des Tokens, das Token selbst liegt beim Client.

| Spalte | Typ | Regeln | Bedeutung |
| --- | --- | --- | --- |
| `id` | INTEGER | `PK` |  |
| `user_id` | INTEGER | `NOT NULL` `→ users CASCADE` | Besitzer der Sitzung. |
| `name` | TEXT | `NOT NULL` | Anzeigename, etwa Browser und System. |
| `kind` | TEXT | `NOT NULL` `CHECK web / device` | Browser-Sitzung oder eingerichtetes Gerät. |
| `token_hash` | TEXT | `NOT NULL` `UNIQUE` | SHA-256 des Sitzungstokens. |
| `created_at` | TEXT | `NOT NULL` |  |
| `last_seen_at` | TEXT |  | Letzte Anfrage. |
| `revoked_at` | TEXT |  | Gesetzt: abgemeldet oder widerrufen; das Token gilt nicht mehr. |
| `idle_locked_at` | TEXT |  | Gesetzt, solange die Sitzung nach Inaktivität gesperrt ist. |
| `sealed_user_key` | TEXT |  | Benutzerschlüssel, versiegelt mit einem Schlüssel aus dem Token (HKDF). So kann der Server Bankzugangsdaten nur während einer Anfrage des Besitzers öffnen. |
| `password_at` | TEXT |  | Letzte Passworteingabe; eine Überweisung fragt nach einer Weile erneut. |

#### `user_settings`

Einstellungen als Schlüssel und Wert, je Benutzer und Geltungsbereich (alle Clients, nur Web, nur macOS).

| Spalte | Typ | Regeln | Bedeutung |
| --- | --- | --- | --- |
| `user_id` | INTEGER | `PK` `→ users CASCADE` |  |
| `scope` | TEXT | `PK` `CHECK all / web / macos` | Für welche Clients die Einstellung gilt. |
| `key` | TEXT | `PK` | Name der Einstellung. |
| `value` | TEXT | `NOT NULL` | Wert als JSON. |
| `updated_at` | TEXT | `NOT NULL` |  |

#### `dashboard_cards`

Die Karten der Übersicht eines Benutzers, auf einem Raster mit 12 Spalten.

| Spalte | Typ | Regeln | Bedeutung |
| --- | --- | --- | --- |
| `id` | INTEGER | `PK` |  |
| `user_id` | INTEGER | `NOT NULL` `→ users CASCADE` |  |
| `position` | INTEGER | `NOT NULL` | Reihenfolge. |
| `type` | TEXT | `NOT NULL` | balance, recent, groups, cashflow, upcoming oder category (geprüft im Schema von shared, nicht per CHECK). |
| `width` | INTEGER | `NOT NULL` `CHECK 1–12` | Breite in Spalten. |
| `height` | INTEGER | `CHECK NULL oder 2–12` | Höhe in Zeilen; NULL folgt dem Inhalt. |
| `title` | TEXT |  | Eigener Titel; NULL: Standardtitel. |
| `config` | TEXT | `NOT NULL` | JSON mit den Einstellungen der Karte (Konten, Zeitraum …). |

#### `activity_log`

Protokoll: wer wann was getan hat. Bleibt lesbar, wenn Benutzer oder Gerät gelöscht werden.

| Spalte | Typ | Regeln | Bedeutung |
| --- | --- | --- | --- |
| `id` | INTEGER | `PK` |  |
| `created_at` | TEXT | `NOT NULL` |  |
| `user_id` | INTEGER | `→ users SET NULL` |  |
| `user_name` | TEXT |  | Name zum Zeitpunkt des Eintrags; bleibt, wenn der Benutzer gelöscht wird. |
| `device_id` | INTEGER | `→ devices SET NULL` |  |
| `action` | TEXT | `NOT NULL` | Was geschah, z. B. login_failed, password_changed, totp_set_up, import, import_undone, sync, sync_failed, transaction_deleted, rules_applied, user_created. |
| `target` | TEXT |  | Worauf es sich bezog, z. B. der Name des Bankzugangs. |
| `details` | TEXT |  | Kurzer Text, z. B. »12 neue Umsätze« oder die Fehlermeldung. |

**Indizes:**

- `activity_log_device (device_id)`

### Bankzugänge

Ein Bankzugang (bank_connections) ist die Bank selbst und wird von allen Benutzern geteilt. Jeder Benutzer hat daran höchstens eine eigene Anmeldung (bank_logins) mit eigenen, versiegelten Zugangsdaten. bank_login_accounts hält fest, welche Anmeldung welches Konto erreicht und was sie dort darf.

#### `bank_connections`

Eine Bank, über FinTS (Bankleitzahl und FinTS-Adresse) oder über PSD2 bei Enable Banking (ASPSP und Land).

| Spalte | Typ | Regeln | Bedeutung |
| --- | --- | --- | --- |
| `id` | INTEGER | `PK` |  |
| `name` | TEXT | `NOT NULL` | Anzeigename des Zugangs. |
| `connector` | TEXT | `NOT NULL` `DEFAULT fints` `CHECK fints / enablebanking` | Welcher Konnektor mit der Bank spricht. |
| `bank_name` | TEXT | `NOT NULL` | Name der Bank. |
| `blz` | TEXT | `NOT NULL` | Bankleitzahl; leer bei PSD2. |
| `bic` | TEXT |  |  |
| `fints_url` | TEXT | `NOT NULL` | FinTS-Adresse; leer bei PSD2. |
| `icon` | TEXT | `NOT NULL` | Symbolname. |
| `color` | TEXT | `NOT NULL` | Farbname. |
| `created_at` | TEXT | `NOT NULL` |  |
| `aspsp` | TEXT | `NOT NULL` `DEFAULT ''` | PSD2: die Bank, wie Enable Banking sie nennt (z. B. PayPal); leer bei FinTS. *Seit 0015.* |
| `country` | TEXT | `NOT NULL` `DEFAULT ''` | PSD2: Land der Bank (DE …); leer bei FinTS. *Seit 0015.* |

**Bedingungen:**

- FinTS genau dann, wenn aspsp und country leer sind
- FinTS genau dann, wenn blz und fints_url gefüllt sind

**Indizes:**

- `bank_connections_fints UNIQUE (blz, fints_url) WHERE connector = 'fints'`
- `bank_connections_psd2 UNIQUE (aspsp, country) WHERE connector = 'enablebanking'`

#### `bank_logins`

Die Anmeldung eines Benutzers an einem Bankzugang: Zugangsdaten, TAN-Verfahren und Zustand. Höchstens eine je Benutzer und Zugang.

| Spalte | Typ | Regeln | Bedeutung |
| --- | --- | --- | --- |
| `id` | INTEGER | `PK` |  |
| `connection_id` | INTEGER | `NOT NULL` `→ bank_connections CASCADE` |  |
| `user_id` | INTEGER | `NOT NULL` `→ users CASCADE` | Besitzer der Anmeldung. |
| `login_hint` | TEXT | `NOT NULL` | Angezeigt statt des Anmeldenamens, z. B. »••••7731«. |
| `sealed_credentials` | TEXT |  | Mit dem Benutzerschlüssel versiegelt. FinTS: JSON { loginName, customerId, pin }; PSD2: JSON { applicationId, privateKey }. |
| `sealed_connector_state` | TEXT |  | Zustand des Konnektors (z. B. Dialog- oder Sitzungsdaten), mit dem Benutzerschlüssel versiegelt. |
| `save_pin` | INTEGER | `NOT NULL` `DEFAULT 1` | 0: Die PIN wird bei jedem Abruf erfragt und nicht gespeichert. |
| `tan_method` | TEXT |  | Gewähltes TAN-Verfahren (Kennung der Bank). |
| `tan_method_name` | TEXT |  | Name des TAN-Verfahrens. |
| `tan_medium` | TEXT |  | TAN-Medium, etwa der Name des Geräts. |
| `status` | TEXT | `NOT NULL` `DEFAULT setup` | setup, ready, credentials_lost, pin_wrong, error, consent_needed. |
| `last_sync_at` | TEXT |  | Letzter erfolgreicher Abruf. |
| `last_error` | TEXT |  | Letzte Fehlermeldung. |
| `created_at` | TEXT | `NOT NULL` |  |
| `consent_until` | TEXT |  | PSD2: wann die letzte Zustimmung bei der Bank endet (ein Zugang kann mehrere halten); NULL bei FinTS und vor der ersten Zustimmung. *Seit 0015.* |

**Bedingungen:**

- UNIQUE (connection_id, user_id)

#### `bank_login_accounts`

Welche Anmeldung welches Konto erreicht, wie der Konnektor es anspricht und welche Geschäftsvorfälle die Bank dafür erlaubt.

| Spalte | Typ | Regeln | Bedeutung |
| --- | --- | --- | --- |
| `login_id` | INTEGER | `PK` `→ bank_logins CASCADE` |  |
| `account_id` | INTEGER | `PK` `→ accounts CASCADE` |  |
| `account_ref` | TEXT | `NOT NULL` | JSON: wie der Konnektor das Konto anspricht. |
| `allowed_operations` | TEXT | `NOT NULL` | JSON: was die Bank dieser Anmeldung für das Konto erlaubt (Umsätze, Überweisung, Daueraufträge …). |
| `last_seen_at` | TEXT |  | Zuletzt von der Bank gemeldet. |
| `missing_since` | TEXT |  | Seit wann die Bank das Konto nicht mehr meldet. |
| `consent_until` | TEXT |  | PSD2: wann die Zustimmung endet, die das Konto erreicht (bei PayPal eine je Konto); NULL bei FinTS. *Seit 0018.* |

**Indizes:**

- `bank_login_accounts_account (account_id)`

#### `bank_ignored_accounts`

Konten, die die Bank meldet, die aber nicht in MBM sollen: beim Angebot nicht übernommen oder vom Bankzugang gelöst. Ein Abruf meldet sie nicht mehr als neu.

| Spalte | Typ | Regeln | Bedeutung |
| --- | --- | --- | --- |
| `connection_id` | INTEGER | `PK` `→ bank_connections CASCADE` |  |
| `external_id` | TEXT | `PK` | Kennung des Kontos beim Konnektor. |
| `created_at` | TEXT | `NOT NULL` |  |

#### `sync_runs`

Ein Abruf bei der Bank: wann, durch wen, mit welchem Ergebnis.

| Spalte | Typ | Regeln | Bedeutung |
| --- | --- | --- | --- |
| `id` | INTEGER | `PK` |  |
| `connection_id` | INTEGER | `→ bank_connections CASCADE` |  |
| `login_id` | INTEGER | `→ bank_logins SET NULL` |  |
| `user_id` | INTEGER | `→ users SET NULL` |  |
| `account_id` | INTEGER | `→ accounts SET NULL` | Ein einzelnes Konto; NULL: der ganze Zugang. |
| `started_at` | TEXT | `NOT NULL` |  |
| `finished_at` | TEXT |  |  |
| `trigger` | TEXT | `NOT NULL` | Auslöser; derzeit immer manual (MBM ruft nie von selbst ab). |
| `result` | TEXT |  | ok oder der Fehlercode. |
| `new_transactions` | INTEGER | `NOT NULL` `DEFAULT 0` | Anzahl neuer Buchungen. |
| `details` | TEXT |  | Fehlermeldung. |

**Indizes:**

- `sync_runs_connection`
- `sync_runs_login`
- `sync_runs_account`

### Konten

Ein Konto mit Bankzugang heißt Bankkonto, eines ohne Offline-Konto. Die Art (kind) sagt, was ein Konto ist, nicht woher es kommt. Der angezeigte Saldo ist opening_balance plus die Summe aller nicht gelöschten Buchungen.

#### `accounts`

Ein Konto: Girokonto, Sparkonto, Kreditkarte, Darlehen, PayPal oder ein selbst geführtes Konto.

| Spalte | Typ | Regeln | Bedeutung |
| --- | --- | --- | --- |
| `id` | INTEGER | `PK` |  |
| `connection_id` | INTEGER | `→ bank_connections sperrt` | Bankzugang; NULL: Offline-Konto. Ohne Löschregel: Ein Zugang lässt sich nicht löschen, solange Konten daran hängen (der Dienst löst oder löscht sie vorher). |
| `external_id` | TEXT |  | Kennung des Kontos beim Konnektor. |
| `iban` | TEXT |  |  |
| `bic` | TEXT |  |  |
| `card_number` | TEXT |  | Kreditkarten: volle Kartennummer, statt der IBAN angezeigt. |
| `name` | TEXT | `NOT NULL` |  |
| `currency` | TEXT | `NOT NULL` `DEFAULT EUR` |  |
| `kind` | TEXT | `NOT NULL` `CHECK` | giro, savings, credit_card, loan, other (bis 0013 auch offline). |
| `reference_account_id` | INTEGER | `→ accounts SET NULL` | Referenzkonto, etwa das Abrechnungskonto einer Kreditkarte. Im Code derzeit nicht verwendet. |
| `group_id` | INTEGER | `→ account_groups SET NULL` | Gruppe in der Seitenleiste; NULL: ohne Gruppe. |
| `icon` | TEXT | `NOT NULL` |  |
| `color` | TEXT | `NOT NULL` |  |
| `position` | INTEGER | `NOT NULL` | Reihenfolge innerhalb der Gruppe. |
| `hidden` | INTEGER | `NOT NULL` `DEFAULT 0` `CHECK 0 / 1` | Ausgeblendet. |
| `opening_balance` | INTEGER |  | Saldo vor der ersten Buchung, in Cent. Bei Bankkonten so gesetzt, dass die Buchungen zum gemeldeten Saldo führen. |
| `created_at` | TEXT | `NOT NULL` |  |
| `info_attributes` | TEXT | `NOT NULL` `DEFAULT []` | JSON [{ key, value }]: eigene Angaben, z. B. Vertragsnummer. |
| `info_notes` | TEXT | `NOT NULL` `DEFAULT ''` | Freie Notizen. |
| `orders_fetched_at` | TEXT |  | Letzter erfolgreicher Abruf der Aufträge; NULL: nie. |
| `transactions_fetched_at` | TEXT |  | Letzter erfolgreicher Abruf der Buchungen; der nächste Abruf beginnt dort. *Seit 0009.* |
| `refetch_all` | INTEGER | `NOT NULL` `DEFAULT 0` `CHECK 0 / 1` | 1: Der nächste Abruf reicht einmal so weit zurück, wie die Bank erlaubt. *Seit 0016.* |

**Bedingungen:**

- (connection_id IS NULL) = (external_id IS NULL): eine Kennung genau dann, wenn ein Bankzugang besteht

**Indizes:**

- `accounts_external UNIQUE (connection_id, external_id) WHERE connection_id IS NOT NULL`

#### `account_groups`

Baum der Kontogruppen in der Seitenleiste, beliebig tief.

| Spalte | Typ | Regeln | Bedeutung |
| --- | --- | --- | --- |
| `id` | INTEGER | `PK` |  |
| `parent_id` | INTEGER | `→ account_groups SET NULL` | Übergeordnete Gruppe; NULL: oberste Ebene. Wird sie gelöscht, rücken die Untergruppen nach oben. |
| `name` | TEXT | `NOT NULL` |  |
| `icon` | TEXT | `NOT NULL` |  |
| `color` | TEXT | `NOT NULL` |  |
| `position` | INTEGER | `NOT NULL` | Reihenfolge unter Geschwistern. |
| `info_attributes` | TEXT | `NOT NULL` `DEFAULT []` | JSON [{ key, value }]. |
| `info_notes` | TEXT | `NOT NULL` `DEFAULT ''` |  |

#### `balances`

Der zuletzt von der Bank gemeldete Saldo, ein Eintrag je Konto. Jeder Abruf überschreibt ihn.

| Spalte | Typ | Regeln | Bedeutung |
| --- | --- | --- | --- |
| `account_id` | INTEGER | `PK` `→ accounts CASCADE` |  |
| `amount` | INTEGER | `NOT NULL` | Gebuchter Saldo in Cent. |
| `currency` | TEXT | `NOT NULL` |  |
| `booked_at` | TEXT |  | Stichtag des Saldos. |
| `pending` | INTEGER |  | Summe der vorgemerkten Umsätze. |
| `available` | INTEGER |  | Verfügbarer Betrag. |
| `credit_line` | INTEGER |  | Kreditlinie. |
| `fetched_at` | TEXT | `NOT NULL` |  |

### Buchungen

transactions ist die größte und am stärksten verknüpfte Tabelle. Die Spalten der Bank bleiben, wie sie kamen; was Benutzer oder Regeln ändern, liegt daneben (transaction_edits, original_amount, original_booking_date).

#### `transactions`

Eine Buchung, von der Bank abgerufen (bank), aus einer CSV-Datei (import) oder von Hand angelegt (manual). AUTOINCREMENT: Eine Kennung wird nie neu vergeben, damit ein Client mit einer alten Kennung nie eine andere Buchung trifft.

| Spalte | Typ | Regeln | Bedeutung |
| --- | --- | --- | --- |
| `id` | INTEGER | `PK` `AUTOINCREMENT` |  |
| `account_id` | INTEGER | `NOT NULL` `→ accounts CASCADE` |  |
| `fingerprint` | TEXT |  | Erkennungsmerkmal, damit ein Abruf oder Import dieselbe Buchung nicht zweimal anlegt. Je Konto eindeutig; Doppel aus der Zeit vor 0012 tragen »‹fingerprint›~‹id›«. |
| `booking_date` | TEXT | `NOT NULL` | Buchungstag JJJJ-MM-TT; der Wert, der zählt. |
| `value_date` | TEXT |  | Wertstellung. |
| `amount` | INTEGER | `NOT NULL` | Betrag in Cent, negativ für Abgänge; der Wert, der zählt. |
| `currency` | TEXT | `NOT NULL` `DEFAULT EUR` |  |
| `counterparty_name` | TEXT | `NOT NULL` `DEFAULT ''` | Name der Gegenseite. |
| `counterparty_iban` | TEXT |  |  |
| `remittance` | TEXT | `NOT NULL` `DEFAULT ''` | Verwendungszweck. |
| `end_to_end_id` | TEXT |  | End-to-End-ID der Bank. Nur sie verknüpft eine Buchung mit einer Überweisung. |
| `status` | TEXT | `NOT NULL` `CHECK booked / pending` | Gebucht oder vorgemerkt. Ein Abruf ersetzt alle vorgemerkten Buchungen der Bank. |
| `raw` | TEXT |  | JSON: was der Konnektor geliefert hat. |
| `first_seen_at` | TEXT | `NOT NULL` | Wann MBM die Buchung zuerst gesehen hat. |
| `source` | TEXT | `NOT NULL` `CHECK bank / manual / import` | Herkunft. |
| `import_id` | INTEGER | `→ imports SET NULL` | Der Import, aus dem sie stammt. |
| `counter_transaction_id` | INTEGER | `→ transactions SET NULL` | Gegenbuchung auf einem anderen eigenen Konto; beide Seiten zeigen aufeinander. |
| `created_by` | INTEGER | `→ users SET NULL` | Wer sie von Hand angelegt hat. |
| `booking_text` | TEXT | `NOT NULL` `DEFAULT ''` | Buchungstext der Bank, z. B. »Lastschrift«. *Seit 0003.* |
| `ultimate_party` | TEXT | `NOT NULL` `DEFAULT ''` | Abweichender Beteiligter, z. B. der Händler einer Kartenzahlung. *Seit 0003.* |
| `reference` | TEXT | `NOT NULL` `DEFAULT ''` | Referenz (aus der End-to-End-ID ohne NOTPROVIDED oder aus der Datei). Verknüpft nie mit Überweisungen. *Seit 0004.* |
| `mandate_id` | TEXT | `NOT NULL` `DEFAULT ''` | SEPA-Mandatsreferenz. *Seit 0004.* |
| `creditor_id` | TEXT | `NOT NULL` `DEFAULT ''` | Gläubiger-ID. *Seit 0004.* |
| `counterparty_bic` | TEXT | `NOT NULL` `DEFAULT ''` | *Seit 0004.* |
| `is_return` | INTEGER | `NOT NULL` `DEFAULT 0` | 1: Rücklastschrift oder Storno. *Seit 0005.* |
| `return_reason` | TEXT | `NOT NULL` `DEFAULT ''` | Rückgabegrund. *Seit 0005.* |
| `return_of_id` | INTEGER | `→ transactions SET NULL` | Die Buchung, die diese Rückgabe zurückgibt. Jede höchstens einmal. *Seit 0005.* |
| `counterparty_account` | TEXT | `NOT NULL` `DEFAULT ''` | Kontonummer der Gegenseite, wenn die Bank keine IBAN nennt. *Seit 0006.* |
| `counterparty_bank_code` | TEXT | `NOT NULL` `DEFAULT ''` | Bankleitzahl der Gegenseite dazu. *Seit 0006.* |
| `customer_reference` | TEXT | `NOT NULL` `DEFAULT ''` | Kundenreferenz (KREF). *Seit 0008.* |
| `bank_reference` | TEXT | `NOT NULL` `DEFAULT ''` | Eigene Referenz der Bank. *Seit 0008.* |
| `funding_of_id` | INTEGER | `→ transactions CASCADE` | PayPal: von MBM ergänzte Buchung, woher das Geld einer Zahlung kam (Bankeinzug, Karte, »Später bezahlen«). Verschwindet mit der Zahlung. *Seit 0016.* |
| `deleted_at` | TEXT |  | Gelöscht. Die Zeile bleibt mit ihrem Fingerprint, damit kein Abruf und kein Import sie zurückbringt; sie lässt sich wiederherstellen. Von Hand angelegte Buchungen werden endgültig gelöscht. *Seit 0017.* |
| `original_amount` | INTEGER |  | Betrag der Bank oder Datei, wenn ein Benutzer ihn geändert hat; NULL: unverändert. Der Abgleich mit Abrufen geht über diesen Wert. *Seit 0017.* |
| `original_booking_date` | TEXT |  | Ebenso für den Buchungstag. *Seit 0017.* |

**Indizes:**

- `transactions_account_date (account_id, booking_date)`
- `transactions_date (booking_date)`
- `transactions_fingerprint UNIQUE (account_id, fingerprint) WHERE fingerprint IS NOT NULL`
- `transactions_return_of UNIQUE (return_of_id) WHERE return_of_id IS NOT NULL`
- `transactions_import, transactions_counter, transactions_funding_of`
- `transactions_deleted (account_id, deleted_at)`

#### `imports`

Ein CSV-Import in ein Konto: Datei, Zuordnung der Spalten, Zahlen. Er lässt sich rückgängig machen.

| Spalte | Typ | Regeln | Bedeutung |
| --- | --- | --- | --- |
| `id` | INTEGER | `PK` |  |
| `account_id` | INTEGER | `NOT NULL` `→ accounts CASCADE` |  |
| `file_name` | TEXT | `NOT NULL` |  |
| `imported_at` | TEXT | `NOT NULL` |  |
| `user_id` | INTEGER | `→ users SET NULL` |  |
| `rows` | INTEGER | `NOT NULL` | Zeilen der Datei. |
| `imported` | INTEGER | `NOT NULL` | Davon übernommen. |
| `skipped` | INTEGER | `NOT NULL` | Übersprungen, etwa weil schon vorhanden. |
| `column_map` | TEXT | `NOT NULL` | JSON: welche Spalte der Datei was bedeutet. |

**Indizes:**

- `imports_account (account_id)`

#### `transaction_edits`

Was ein Benutzer oder eine Regel an Gegenseite oder Verwendungszweck einer Buchung ändert. Die Spalten der Bank bleiben unverändert. Seit Migration 0007.

| Spalte | Typ | Regeln | Bedeutung |
| --- | --- | --- | --- |
| `transaction_id` | INTEGER | `PK` `→ transactions CASCADE` |  |
| `field` | TEXT | `PK` `CHECK counterparty / remittance` | Welches Feld. |
| `value` | TEXT |  | Angezeigter Text; NULL: bewusst der Wert der Bank. |
| `source` | TEXT | `NOT NULL` `CHECK rule / manual` | Von einer Regel oder von Hand. Beim Anwenden von Regeln sind Änderungen an von Hand bearbeiteten Feldern nicht vorausgewählt. |

#### `transaction_unread`

Buchungen, die ein Benutzer noch nicht angesehen hat. Nur ungelesene haben eine Zeile. Seit Migration 0002.

| Spalte | Typ | Regeln | Bedeutung |
| --- | --- | --- | --- |
| `user_id` | INTEGER | `PK` `→ users CASCADE` |  |
| `transaction_id` | INTEGER | `PK` `→ transactions CASCADE` |  |

**Bedingungen:**

- WITHOUT ROWID

**Indizes:**

- `transaction_unread_tx (transaction_id)`

### Kategorien und Regeln

Eine Buchung bekommt ihre Kategorie über Anteile in transaction_categories. Heute hat jede Buchung höchstens einen Anteil mit dem vollen Betrag; die Tabelle ist schon für geteilte Buchungen gebaut. Regeln setzen Kategorie und Texte anhand einer Suchanfrage.

#### `categories`

Baum der Kategorien.

| Spalte | Typ | Regeln | Bedeutung |
| --- | --- | --- | --- |
| `id` | INTEGER | `PK` |  |
| `parent_id` | INTEGER | `→ categories CASCADE` | Übergeordnete Kategorie; NULL: oberste Ebene. Wird sie gelöscht, gehen die Unterkategorien mit. |
| `name` | TEXT | `NOT NULL` |  |
| `icon` | TEXT | `NOT NULL` |  |
| `color` | TEXT |  | Farbname; NULL bei Unterkategorien (sie erben). |
| `position` | INTEGER | `NOT NULL` |  |
| `excluded_from_stats` | INTEGER | `NOT NULL` `DEFAULT 0` | 1: zählt nicht in Auswertungen (z. B. Umbuchungen). |
| `counter_default` | INTEGER | `NOT NULL` `DEFAULT 0` | 1: voreingestellte Kategorie für Gegenbuchungen und erkannte Umbuchungen. |
| `info_attributes` | TEXT | `NOT NULL` `DEFAULT []` | JSON [{ key, value }]. |
| `info_notes` | TEXT | `NOT NULL` `DEFAULT ''` |  |

#### `transaction_categories`

Anteil einer Buchung an einer Kategorie. Auswertungen summieren diese Anteile, nicht die Buchungsbeträge.

| Spalte | Typ | Regeln | Bedeutung |
| --- | --- | --- | --- |
| `transaction_id` | INTEGER | `PK` `→ transactions CASCADE` |  |
| `category_id` | INTEGER | `PK` `→ categories CASCADE` |  |
| `amount` | INTEGER | `NOT NULL` | Anteil in Cent; bei nur einem Anteil der volle Betrag der Buchung. |
| `source` | TEXT | `NOT NULL` `CHECK rule / manual / auto` | Von einer Regel, von Hand oder automatisch (erkannte Umbuchung zwischen eigenen Konten). |
| `rule_id` | INTEGER | `→ rules SET NULL` | Die Regel, die den Anteil gesetzt hat. |

**Indizes:**

- `transaction_categories_category (category_id)`
- `transaction_categories_rule (rule_id)`

#### `rules`

Regel: Suchanfrage, dazu Kategorie, Textauszüge und Textänderungen. Bis 0007 hieß die Tabelle category_rules und konnte nur eine Kategorie setzen.

| Spalte | Typ | Regeln | Bedeutung |
| --- | --- | --- | --- |
| `id` | INTEGER | `PK` |  |
| `name` | TEXT | `NOT NULL` `DEFAULT ''` |  |
| `query` | TEXT | `NOT NULL` | Suchanfrage in der Syntax der Umsatzliste. |
| `category_id` | INTEGER | `→ categories SET NULL` | Zu setzende Kategorie; NULL: keine. |
| `extracts` | TEXT | `NOT NULL` `DEFAULT []` | JSON: Auszüge aus Textfeldern (pattern, separator, keywords) mit benannten Teilen. |
| `edits` | TEXT | `NOT NULL` `DEFAULT []` | JSON: Änderungen an Gegenseite oder Verwendungszweck (set, remove, replace), mit Platzhaltern aus den Auszügen. |
| `all_accounts` | INTEGER | `NOT NULL` `DEFAULT 1` | 1: gilt für alle Konten; 0: nur für die in rule_accounts. |
| `position` | INTEGER | `NOT NULL` | Reihenfolge; frühere Regeln gehen vor. |
| `active` | INTEGER | `NOT NULL` `DEFAULT 1` |  |
| `created_at` | TEXT | `NOT NULL` |  |

#### `rule_accounts`

Die Konten, für die eine Regel gilt, wenn all_accounts = 0. Seit Migration 0007.

| Spalte | Typ | Regeln | Bedeutung |
| --- | --- | --- | --- |
| `rule_id` | INTEGER | `PK` `→ rules CASCADE` |  |
| `account_id` | INTEGER | `PK` `→ accounts CASCADE` |  |

**Indizes:**

- `rule_accounts_account (account_id)`

#### `uncategorized_slot`

Wo »Ohne Kategorie« im Kategorienbaum steht. Höchstens eine Zeile; keine bedeutet: oberste Ebene, ganz unten.

| Spalte | Typ | Regeln | Bedeutung |
| --- | --- | --- | --- |
| `id` | INTEGER | `PK` `CHECK id = 1` | Immer 1. |
| `parent_id` | INTEGER | `→ categories SET NULL` | Darunter; NULL: oberste Ebene. |
| `position` | INTEGER |  | Position unter den Geschwistern; NULL: zuletzt. |

### Aufträge und Überweisungen

standing_orders und scheduled_transfers spiegeln, was die Bank hält; jeder Abruf ersetzt sie, lokal wird darin nichts bearbeitet. transfers ist das Gegenstück: jeder Auftrag, den MBM an die Bank schickt, mit seinem Zustand.

#### `transfers`

Ein Auftrag von MBM an die Bank: eine Überweisung (execution now), ein Termin (date) oder ein Dauerauftrag (standing), jeweils angelegt, geändert oder gelöscht (action). Wird nie von selbst wiederholt.

| Spalte | Typ | Regeln | Bedeutung |
| --- | --- | --- | --- |
| `id` | INTEGER | `PK` |  |
| `request_id` | TEXT | `NOT NULL` `UNIQUE` | Vom Client; eine zweite Anfrage damit ist derselbe Auftrag. |
| `account_id` | INTEGER | `NOT NULL` `→ accounts CASCADE` |  |
| `login_id` | INTEGER | `→ bank_logins SET NULL` | Mit welcher Anmeldung gesendet. |
| `created_by` | INTEGER | `→ users SET NULL` |  |
| `created_by_name` | TEXT | `NOT NULL` | Bleibt, wenn der Benutzer gelöscht wird. |
| `payee_name` | TEXT | `NOT NULL` |  |
| `payee_iban` | TEXT | `NOT NULL` |  |
| `payee_bic` | TEXT |  |  |
| `amount` | INTEGER | `NOT NULL` | Cent, größer als 0. |
| `remittance` | TEXT | `NOT NULL` |  |
| `end_to_end_id` | TEXT | `NOT NULL` `UNIQUE` | Von MBM vergeben; findet später die Buchung. |
| `instant` | INTEGER | `NOT NULL` `DEFAULT 0` `CHECK 0 / 1` | Echtzeitüberweisung. |
| `execution` | TEXT | `NOT NULL` `DEFAULT now` `CHECK now / date / standing` | Sofort, zum Termin oder als Dauerauftrag. |
| `status` | TEXT | `NOT NULL` `CHECK` | submitting, awaiting_vop_confirm, awaiting_tan, executed, rejected, failed, cancelled, unknown (Abbildung unten). |
| `vop_result` | TEXT |  | Ergebnis der Empfängerprüfung (Verification of Payee). |
| `vop_name` | TEXT |  | Name, den die Bank des Empfängers führt (bei ähnlichem Namen). |
| `vop_reason` | TEXT |  |  |
| `vop_text` | TEXT |  | Erklärung der Bank. |
| `vop_structured` | INTEGER | `NOT NULL` `DEFAULT 0` `CHECK 0 / 1` | 1: Die Bank hat das Ergebnis strukturiert geliefert. |
| `bank_message` | TEXT |  | Antwort der Bank. |
| `bank_reference` | TEXT |  |  |
| `unconfirmed` | INTEGER | `NOT NULL` `DEFAULT 0` `CHECK 0 / 1` | Echtzeit: Eingang noch nicht bestätigt. |
| `transaction_id` | INTEGER | `→ transactions SET NULL` | Die Buchung, die der Abruf dazu gefunden hat. |
| `created_at` | TEXT | `NOT NULL` |  |
| `updated_at` | TEXT | `NOT NULL` |  |
| `finished_at` | TEXT |  |  |
| `action` | TEXT | `NOT NULL` `DEFAULT create` `CHECK create / change / delete` | Was mit dem Auftrag geschieht. *Seit 0010.* |
| `execution_date` | TEXT |  | Bei date: der Ausführungstag. *Seit 0010.* |
| `first_date` | TEXT |  | Bei standing: erste Ausführung. *Seit 0010.* |
| `unit` | TEXT | `CHECK NULL / month / week` | Bei standing: Rhythmus in Monaten oder Wochen. *Seit 0010.* |
| `every` | INTEGER |  | Bei standing: alle n Einheiten. *Seit 0010.* |
| `execution_day` | INTEGER |  | Bei standing: Ausführungstag (wie in standing_orders). *Seit 0010.* |
| `last_date` | TEXT |  | Bei standing: letzte Ausführung. *Seit 0010.* |
| `order_id` | INTEGER | `ohne FK` | Zeile in standing_orders oder scheduled_transfers. Ohne Fremdschlüssel, weil jeder Abruf die Aufträge ersetzt. *Seit 0010.* |
| `bank_order_id` | TEXT |  | Kennung der Bank: angegeben bei change und delete, gemeldet bei create. *Seit 0010.* |
| `previous` | TEXT |  | JSON: der Auftrag vor Änderung oder Löschung. *Seit 0010.* |

**Bedingungen:**

- now: nur action create, ohne Termin, Rhythmus und previous
- date: mit execution_date, ohne Rhythmus
- standing: mit first_date, unit, every, execution_day, ohne execution_date
- change und delete: mit bank_order_id und previous

**Indizes:**

- `transfers_account (account_id)`
- `transfers_created (created_at)`
- `transfers_transaction (transaction_id)`

#### `standing_orders`

Daueraufträge, wie die Bank sie meldet.

| Spalte | Typ | Regeln | Bedeutung |
| --- | --- | --- | --- |
| `id` | INTEGER | `PK` |  |
| `account_id` | INTEGER | `NOT NULL` `→ accounts CASCADE` |  |
| `bank_order_id` | TEXT |  | Kennung der Bank. |
| `payee_name` | TEXT | `NOT NULL` |  |
| `payee_iban` | TEXT | `NOT NULL` |  |
| `payee_bic` | TEXT |  |  |
| `amount` | INTEGER | `NOT NULL` | Cent, nicht negativ. |
| `remittance` | TEXT | `NOT NULL` |  |
| `unit` | TEXT | `NOT NULL` `CHECK month / week` |  |
| `every` | INTEGER | `NOT NULL` | Alle n Monate oder Wochen. |
| `execution_day` | INTEGER | `NOT NULL` | Monat: 1–30, 97–99 vom Monatsende gezählt; Woche: 1 (Montag) bis 7. |
| `first_date` | TEXT | `NOT NULL` |  |
| `last_date` | TEXT |  |  |
| `can_change` | INTEGER |  | Darf geändert werden; NULL: Die Bank sagt es nicht. |
| `can_delete` | INTEGER |  | Ebenso für Löschen. |
| `fetched_at` | TEXT | `NOT NULL` |  |
| `end_to_end_id` | TEXT |  | Klärt einen Auftrag mit unbekanntem Ausgang. *Seit 0010.* |

**Indizes:**

- `standing_orders_account (account_id)`

#### `scheduled_transfers`

Terminüberweisungen, wie die Bank sie meldet.

| Spalte | Typ | Regeln | Bedeutung |
| --- | --- | --- | --- |
| `id` | INTEGER | `PK` |  |
| `account_id` | INTEGER | `NOT NULL` `→ accounts CASCADE` |  |
| `bank_order_id` | TEXT |  |  |
| `payee_name` | TEXT | `NOT NULL` |  |
| `payee_iban` | TEXT | `NOT NULL` |  |
| `payee_bic` | TEXT |  |  |
| `amount` | INTEGER | `NOT NULL` | Cent. |
| `remittance` | TEXT | `NOT NULL` |  |
| `execution_date` | TEXT | `NOT NULL` |  |
| `can_change` | INTEGER |  |  |
| `can_delete` | INTEGER |  |  |
| `fetched_at` | TEXT | `NOT NULL` |  |
| `end_to_end_id` | TEXT |  | *Seit 0010.* |

**Indizes:**

- `scheduled_transfers_account (account_id)`

#### `payees`

Liste der Empfänger für die Auswahl beim Überweisen; eine Zeile je IBAN. Ohne Verweise.

| Spalte | Typ | Regeln | Bedeutung |
| --- | --- | --- | --- |
| `id` | INTEGER | `PK` |  |
| `name` | TEXT | `NOT NULL` |  |
| `iban` | TEXT | `NOT NULL` `UNIQUE` |  |
| `bic` | TEXT |  |  |
| `last_used_at` | TEXT |  | Sortiert die Vorschläge. |
| `created_at` | TEXT | `NOT NULL` |  |

### Eigenständig

Tabellen ohne Fremdschlüssel.

#### `import_formats`

Eigene CSV-Importformate neben den mitgelieferten Vorlagen. Seit Migration 0004.

| Spalte | Typ | Regeln | Bedeutung |
| --- | --- | --- | --- |
| `id` | INTEGER | `PK` `AUTOINCREMENT` |  |
| `name` | TEXT | `NOT NULL` `UNIQUE` `NOCASE` |  |
| `definition` | TEXT | `NOT NULL` | JSON: Trennzeichen, Kodierung, Zuordnung der Spalten (Schema in shared/src/importFormat.ts). |
| `created_at` | TEXT | `NOT NULL` |  |
| `updated_at` | TEXT | `NOT NULL` |  |

#### `migrations`

Welche Migrationen gelaufen sind (Umzug-Speicher, angelegt in db/database.ts).

| Spalte | Typ | Regeln | Bedeutung |
| --- | --- | --- | --- |
| `name` | TEXT | `PK` | Name der Migration, z. B. 0017-booking-edits. |
| `applied_at` | TEXT | `NOT NULL` |  |

## Buchungen und Aufträge

Die meisten Regeln des Modells drehen sich um `transactions`. Was der Code beim Abrufen, Importieren
und Bearbeiten sicherstellt:

- **Keine Doppel:** Abruf und Import berechnen einen `fingerprint`, der je Konto eindeutig ist.
  Vorgemerkte Buchungen der Bank (`status = 'pending'`) ersetzt jeder Abruf vollständig.
- **Bankwerte bleiben:** Ändert jemand Betrag oder Buchungstag, wandert der Wert der Bank nach
  `original_amount` bzw. `original_booking_date`; der Abgleich mit späteren Abrufen nutzt den
  Originalwert. Gegenseite und Verwendungszweck ändern sich nur über `transaction_edits`.
- **Weich löschen:** Buchungen von Bank, Import und PayPal-Ergänzung bekommen `deleted_at` und
  bleiben mit Fingerprint stehen, damit sie nicht wiederkommen. Listen, Salden und Auswertungen
  lassen sie aus.
- **Drei Selbstverweise:** `counter_transaction_id` verbindet eine Umbuchung zwischen eigenen
  Konten (beide Seiten zeigen aufeinander). `return_of_id` zeigt von einer Rücklastschrift auf die
  zurückgegebene Buchung, jede höchstens einmal. `funding_of_id` zeigt von der
  Finanzierungsbuchung, die MBM für PayPal ergänzt, auf die Zahlung und verschwindet mit ihr.
- **Kategorie als Anteil:** Auswertungen summieren `transaction_categories.amount`. Erkannte
  Umbuchungen bekommen automatisch (`source = 'auto'`) die Kategorie mit `counter_default = 1`.
- **Überweisung und Buchung:** Eine Zeile in `transfers` trägt eine von MBM vergebene
  `end_to_end_id`. Bringt ein Abruf die Buchung mit dieser ID, setzt MBM `transfers.transaction_id`.

![Zustände in transfers.status, von submitting über die Wartezustände zu executed, rejected, unknown, cancelled oder failed](assets/diagrams/ueberweisung-zustaende.svg)

MBM sendet nie von selbst ein zweites Mal: Ist unklar, ob die Bank ausgeführt hat, endet der Auftrag
als `unknown`. Findet ein späterer Abruf die Buchung über die End-to-End-ID, wird daraus
`executed`; bei Terminen und Daueraufträgen klärt das der nächste Abruf der Aufträge. Mehr dazu
unter [Überweisungen](development.md#überweisungen).

## Was beim Löschen passiert

Die Löschregeln der Fremdschlüssel, nach dem Gelöschten geordnet. SQLite prüft sie, weil
`foreign_keys = ON` gesetzt ist.

| Gelöscht wird | Geht mit (CASCADE) | Verweis wird geleert (SET NULL) | Hinweis |
| --- | --- | --- | --- |
| Benutzer | `devices`, `user_settings`, `dashboard_cards`, `bank_logins` (und deren `bank_login_accounts`), `transaction_unread` | `imports.user_id`, `transactions.created_by`, `activity_log.user_id`, `sync_runs.user_id`, `transfers.created_by` | Namen bleiben in `activity_log.user_name` und `transfers.created_by_name`. |
| Bankzugang | `bank_logins`, `bank_ignored_accounts`, `sync_runs` | – | Gesperrt, solange Konten daran hängen: `deleteConnection` löst sie vorher (dann Offline-Konten) oder löscht sie. |
| Konto | `transactions` mit allem, was daran hängt, `imports`, `balances`, `bank_login_accounts`, `standing_orders`, `scheduled_transfers`, `transfers`, `rule_accounts` | `accounts.reference_account_id` anderer Konten, `sync_runs.account_id` | |
| Buchung, endgültig | `transaction_categories`, `transaction_edits`, `transaction_unread`, PayPal-Finanzierungsbuchungen (`funding_of_id`) | `counter_transaction_id` und `return_of_id` anderer Buchungen, `transfers.transaction_id` | Buchungen von Bank, Import und PayPal-Ergänzung löscht MBM nur weich (`deleted_at`); endgültig nur die von Hand angelegten. |
| Import | – | `transactions.import_id` | Die Buchungen bleiben. „Import rückgängig“ löscht sie im Dienst ausdrücklich. |
| Kategorie | Unterkategorien, `transaction_categories` | `rules.category_id`, `uncategorized_slot.parent_id` | Betroffene Buchungen stehen danach unter „Ohne Kategorie“. |
| Regel | `rule_accounts` | `transaction_categories.rule_id` | Gesetzte Kategorien und Texte bleiben. |
| Kontogruppe | – | `accounts.group_id`, `account_groups.parent_id` | Konten stehen danach ohne Gruppe, Untergruppen auf der obersten Ebene. |
| Gerät oder Sitzung | – | `activity_log.device_id` | Normal wird eine Sitzung nur widerrufen (`revoked_at`). |

## Migrationen

Je Migration eine Datei in `server/src/db/migrations/`; die Regeln dazu stehen unter
[Entwicklung › Datenbank](development.md#datenbank). Wo eine Tabelle neu gebaut werden muss (SQLite
kann Spalten nicht ändern), läuft die Migration mit abgeschalteten Fremdschlüsseln
(`foreignKeysOff`) und prüft sie vor dem Commit mit `foreign_key_check`.

| Migration | Was sie ändert |
| --- | --- |
| `0001-initial` | Grundschema: Benutzer, Konten, Buchungen, Kategorien, Bankzugänge, Aufträge, Überweisungen (zusammengefasst am 20.11.2026). |
| `0002-unread` | transaction_unread: ungelesene Buchungen je Benutzer. |
| `0003-booking-details` | transactions.booking_text und ultimate_party. |
| `0004-import-formats` | import_formats; reference, mandate_id, creditor_id, counterparty_bic als Spalten, aus raw übernommen. |
| `0005-booking-returns` | Rückgaben: is_return, return_reason, return_of_id. |
| `0006-counterparty-account` | Kontonummer und Bankleitzahl der Gegenseite ohne IBAN. |
| `0007-rule-actions` | category_rules wird rules mit Auszügen und Textänderungen; rule_accounts, transaction_edits. |
| `0008-booking-references` | customer_reference (KREF) und bank_reference. |
| `0009-transactions-fetched-at` | accounts.transactions_fetched_at. |
| `0010-order-writes` | transfers auch für Termine und Daueraufträge (action, Rhythmus, previous). |
| `0011-foreign-key-indexes` | Indizes auf Fremdschlüsseln großer Tabellen; ein Import mit 10.000 Buchungen ließ sich vorher nur langsam rückgängig machen. |
| `0012-booking-guards` | Fingerprint je Konto eindeutig; Anteile in transaction_categories gleich dem Buchungsbetrag. |
| `0013-account-kind` | kind offline entfällt (neu: other); connection_id wird Fremdschlüssel ohne Löschregel. |
| `0014-transfer-checks` | CHECKs, die je Art eines Auftrags die passenden Spalten verlangen. |
| `0015-psd2-connections` | PSD2 über Enable Banking: aspsp, country, consent_until, Status consent_needed. |
| `0016-paypal-funding` | transactions.funding_of_id und accounts.refetch_all für PayPal. |
| `0017-booking-edits` | Weiches Löschen (deleted_at) und geänderte Beträge und Daten mit Originalwert. |
| `0018-psd2-account-consents` | bank_login_accounts.consent_until: mehrere Zustimmungen je PSD2-Zugang, jede mit eigenem Ende. |

## Diese Seite pflegen

Nach jeder neuen Migration:

1. Neue Tabellen und Spalten hier eintragen, in der Reihenfolge der Datenbank und mit „Seit“; die
   Migration in der Tabelle oben ergänzen und den Stand im Kopf der Seite.
2. Ändert sich eine Löschregel, auch [Was beim Löschen passiert](#was-beim-löschen-passiert).
3. Neue Tabelle oder neuer Fremdschlüssel: in `scripts/diagrams/figures.ts` eintragen,
   `npm run diagrams` ausführen und das Bild ansehen. Was der Generator kann, steht in
   [scripts/diagrams/README.md](https://github.com/stefgo/my-banking-manager/blob/main/scripts/diagrams/README.md).

`server/src/db/schemaDocs.test.ts` hält dich dabei: Er baut eine leere Datenbank mit allen
Migrationen und vergleicht sie mit dieser Seite. Fehlt eine Tabelle oder Spalte, steht eine zu viel,
stimmt die Reihenfolge nicht oder fehlt eine Tabelle im Übersichtsbild, schlägt `npm test` fehl.
