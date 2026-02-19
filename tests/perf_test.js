
require('dotenv').config();
const videoService = require('../services/videoService');

async function runTests() {
    console.log('--- Starting Performance Test ---');

    // Test 1: Full Video List (Legacy)
    console.log('\n[Test 1] getAllVideos (Full List - Legacy)');
    const start1 = performance.now();
    const videos1 = await videoService.getAllVideos();
    const end1 = performance.now();
    console.log(`Count: ${videos1.length}`);
    console.log(`Time: ${(end1 - start1).toFixed(2)}ms`);

    // Test 2: Paginated Video List
    console.log('\n[Test 2] getPaginatedVideos (Page 1, Limit 20)');
    const start2 = performance.now();
    const result2 = await videoService.getPaginatedVideos(1, 20);
    const end2 = performance.now();
    console.log(`Count: ${result2.data.length}`);
    console.log(`Total Items: ${result2.pagination.total_items}`);
    console.log(`Time: ${(end2 - start2).toFixed(2)}ms`);

    // Test 3: Series List (Optimized)
    console.log('\n[Test 3] getSeriesList');
    const start3 = performance.now();
    const series = await videoService.getSeriesList();
    const end3 = performance.now();
    console.log(`Count: ${series.length}`);
    console.log(`Time: ${(end3 - start3).toFixed(2)}ms`);
}

runTests().catch(console.error);
