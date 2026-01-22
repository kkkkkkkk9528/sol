const anchor = require('@coral-xyz/anchor');
const fs = require('fs');
const path = require('path');

const provider = anchor.AnchorProvider.env();
console.log('Provider:', typeof provider);
console.log('Provider connection:', typeof provider.connection);
console.log('Provider wallet:', typeof provider.wallet);

const idl = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'target/idl/slot_machine.json'), 'utf8'));
console.log('IDL loaded:', idl.name);

const programId = new anchor.web3.PublicKey('GtSdwriBEDSUrrdxx1tHA1TV8aAgA9bSKcPmeYCUQhBg');
console.log('ProgramId:', programId.toString());

const program = new anchor.Program(idl, programId, provider);
console.log('Program created:', program.programId.toString());
