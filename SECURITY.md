# Security

## Reporting a problem

Please do not open a public issue for a security problem. Report it privately through GitHub instead: on the repository's **Security** tab, choose **Report a vulnerability**. Only the maintainers can read the report.

Say what an attacker can do, with the smallest room or request that shows it, and which version you found it in. You will get an answer within a week. A fix is released as a patch version, with credit in the changelog unless you would rather not be named.

## What counts

Tickflare runs in your Worker and decides who may join a room, what each player may see, and which commands are applied. Problems in that are what this policy is for, for example:

- a player joining a room, or acting as another player, without a valid join token;
- a player receiving part of the state their `view()` does not give them;
- a command or frame from a client that crashes a room, corrupts its saved state, or gets around `parseCommand`, rate limits or message size limits;
- accounts: signing in as someone else, reading another account's data, or getting around recovery codes or password resets.

Bugs in your own game's rules, and the costs of a room that your code keeps awake, are not security problems, though they are welcome as ordinary issues.

## Supported versions

Before 1.0, fixes go into the latest minor version only.
