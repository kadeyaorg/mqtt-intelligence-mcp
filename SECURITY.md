# Security policy

## Reporting a vulnerability

**Do not open a public issue.**

Use GitHub's private vulnerability reporting: the **Security** tab of this repository,
then **Report a vulnerability**. It is private to the maintainers, and it gives us a place to
work with you on a fix and a coordinated disclosure.

If you would rather not use GitHub, or do not have an account, email **christophe@kadeya.com**.

Please include what you would want to receive: what the issue is, how to reproduce it, what
an attacker gains, and the version or commit you tested. A proof of concept helps; a working
exploit is not required.

We aim to acknowledge a report within three working days and to tell you, within ten, whether
we consider it a vulnerability and what the fix looks like. We will credit you in the advisory
unless you prefer otherwise.

## Supported versions

Pre-1.0: the latest minor line receives fixes. There are no long-term support branches yet.

## What is in scope

Anything that lets an agent, a payload or a broker cause this server to do something its
configuration forbids. In particular:

- a read policy that can be bypassed — a denied topic appearing in any answer, by any route;
- a secret reaching a log, an error message, a tool result or a serialization;
- a payload or topic name that escapes its quoting or classification, including content that
  a model would read as instructions rather than as data;
- an unbounded allocation driven by broker traffic: a payload, a topic count or a history
  that grows past its configured limit;
- a path traversal or arbitrary read through a configuration reference;
- anything written to **stdout** other than MCP protocol frames, which corrupts the session.

## What is not in scope

- **Your broker's access control.** This server's read policy is a second lock. If an account
  can subscribe to a topic, a compromised host running this server can read it. The deployment
  guidance is a dedicated account restricted to what the agent is meant to see, and the
  threat model in [docs/security.md](docs/security.md) says so explicitly.
- **A broker that accepts a subscription and delivers nothing on it.** No MQTT client can
  detect that, this one included. `check` reports what the broker accepted, not what it will
  deliver.
- **What your MCP client sends to its model.** This server truncates, redacts and bounds what
  it returns; what the client then does with it is the client's decision.
- **Publishing.** There is no publish path in this version. If you find one, that is very much
  in scope.
- Vulnerabilities in dependencies that we only forward: report those upstream, and tell us so
  we can pin or patch.

## Hardening checklist for a deployment

1. A dedicated broker account, read-only, restricted to the topics the agent is meant to see.
2. TLS, with certificate verification left on.
3. `security.read.allow` narrowed, and `discovery.filters` narrowed with it, so the broker is
   never even asked for the rest.
4. `security.read.deny` for anything sensitive that the allow list would otherwise include.
   Deny beats allow, everywhere.
5. `security.redaction.jsonKeys` extended with your own payload keys — matching is on whole
   key names, so `apikey` does not catch `maintenanceApiKey`.
6. Secrets passed by reference (`{ env: … }` or `{ file: … }`), never written into the file.
7. `check` run before wiring the server to an agent, and its exit code acted on.

[docs/security.md](docs/security.md) explains what each of these defends against, and what
none of them defend against.
