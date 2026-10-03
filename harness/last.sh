#!/bin/bash
grep '"type":"agent_end"' /tmp/pi-teach-e2e/events.jsonl | tail -1 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);for(const m of r.messages){if(m.role==="assistant")console.log("A:",m.content.filter(c=>c.type==="text").map(c=>c.text).join("\n").slice(0,1500));if(m.role==="user")console.log("U:",JSON.stringify(m.content).slice(0,300))}})'
