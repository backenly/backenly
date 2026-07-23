/**
 * Script to add status field to all intent returns in intent-parser.ts
 */

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'lib', 'orchestration', 'intent-parser.ts');

let content = fs.readFileSync(filePath, 'utf8');

// Replace all return { with return createIntent({
// But only for intent object returns (those with intent_type)
const lines = content.split('\n');
const updatedLines = [];
let insideReturn = false;
let braceDepth = 0;
let returnStartLine = -1;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const trimmed = line.trim();
  
  // Check if this line starts a return statement
  if (trimmed.startsWith('return {')) {
    // Look ahead to see if this is an intent return (has intent_type)
    let hasIntentType = false;
    let checkDepth = 1;
    for (let j = i; j < Math.min(i + 15, lines.length); j++) {
      if (lines[j].includes('intent_type:')) {
        hasIntentType = true;
        break;
      }
      // Count braces to know when we're done with this object
      checkDepth += (lines[j].match(/{/g) || []).length;
      checkDepth -= (lines[j].match(/}/g) || []).length;
      if (checkDepth === 0) break;
    }
    
    if (hasIntentType) {
      // Replace return { with return createIntent({
      updatedLines.push(line.replace('return {', 'return createIntent({'));
      insideReturn = true;
      returnStartLine = i;
      braceDepth = 1;
    } else {
      updatedLines.push(line);
    }
  } else {
    updatedLines.push(line);
    
    if (insideReturn) {
      // Count braces to track when we close the object
      braceDepth += (line.match(/{/g) || []).length;
      braceDepth -= (line.match(/}/g) || []).length;
      
      // When we close the object, add the closing paren for createIntent
      if (braceDepth === 0 && trimmed === '}') {
        updatedLines[updatedLines.length - 1] = line.replace('}', '})');
        insideReturn = false;
      }
    }
  }
}

const updatedContent = updatedLines.join('\n');

// Write back
fs.writeFileSync(filePath, updatedContent, 'utf8');

console.log('✅ Successfully added status field to all intent returns');
