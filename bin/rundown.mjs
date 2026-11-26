#!/usr/bin/env node
import { main } from "../sources/Cli.mjs";
process.exitCode = await main();
