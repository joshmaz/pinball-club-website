const context = process.env.CONTEXT || 'unknown';

if (context === 'deploy-preview') {
  console.log('Building the Netlify Deploy Preview.');
  process.exit(1);
}

console.log(`Skipping Netlify ${context} deploy; persistent staging and production are hosted on AWS.`);
process.exit(0);
