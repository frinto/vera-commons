import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdmissionManager } from '../src/admission.mjs';
const kb={chains:[['falcon','bird','animal'],['oak','tree','plant'],['salmon','fish','animal']]};
const roots=[];
function fixture(windowMs=1000){const dir=mkdtempSync(join(tmpdir(),'interview-red-'));roots.push(dir);const clock={value:100};return {clock,manager:createAdmissionManager({dir,salt:'red-arm-secret',kb,items:1,windowMs,now:()=>clock.value})};}
const failures=[];
function check(name, run){try{run();console.log(`PASS ${name}`);}catch(error){failures.push(name);console.error(`FAIL ${name}: ${error.name}: ${error.message}`);}}
try {
 const unknown=fixture(); check('unknown_admission',()=>assert.deepEqual(unknown.manager.interview('missing',{statement:'S',answers:{}}),{reason:'unknown_admission'}));
 const expired=fixture(10); const expiredId=expired.manager.start('expired').id; expired.clock.value=110; check('expired',()=>assert.deepEqual(expired.manager.interview(expiredId,{statement:'S',answers:{}}),{reason:'expired'}));
 const decided=fixture(); const decidedId=decided.manager.start('decided').id; decided.manager.answer(decidedId,['']); decided.manager.decide(decidedId,'refuse','admin'); check('already_decided',()=>assert.deepEqual(decided.manager.interview(decidedId,{statement:'S',answers:{}}),{reason:'already_decided'}));
 const valid=fixture(); const id=valid.manager.start('valid').id;
 check('empty statement rejected explicitly',()=>assert.deepEqual(valid.manager.interview(id,{statement:'',answers:{}}),{reason:'bad_statement'}));
 check('overlength statement rejected explicitly',()=>assert.deepEqual(valid.manager.interview(id,{statement:'x'.repeat(4001),answers:{}}),{reason:'statement_too_long'}));
 check('non-object answers rejected explicitly',()=>assert.deepEqual(valid.manager.interview(id,{statement:'S',answers:[]}),{reason:'bad_answers'}));
 check('overlength answer rejected explicitly',()=>assert.deepEqual(valid.manager.interview(id,{statement:'S',answers:{q:'x'.repeat(4001)}}),{reason:'answer_too_long'}));
 check('valid empty answers accepted',()=>assert.deepEqual(valid.manager.interview(id,{statement:'S',answers:{}}),{ok:true,id}));
 check('list includes interview field',()=>assert.equal(valid.manager.list()[0].interview.statement,'S'));
 check('replace-on-resubmit',()=>{const a=valid.manager.interview(id,{statement:'First',answers:{}});valid.clock.value+=1;const b=valid.manager.interview(id,{statement:'Second',answers:{}});assert.deepEqual([a,b,valid.manager.list()[0].interview.statement],[{ok:true,id},{ok:true,id},'Second']);});
 const optional=fixture();const optionalId=optional.manager.start('optional').id;optional.manager.answer(optionalId,['']);
 check('optional interview is represented as null',()=>assert.equal(optional.manager.list()[0].interview,null));
 check('no interview does not block admin decision',()=>assert.equal(optional.manager.decide(optionalId,'grant','admin').decision,'grant'));
 console.log(`RED ASSERTIONS FAILED ${failures.length}: ${failures.join(' | ')}`);
 if(failures.length) process.exitCode=1;
} finally {for(const dir of roots)rmSync(dir,{recursive:true,force:true});}
