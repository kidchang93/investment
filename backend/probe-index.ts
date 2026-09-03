import { getDomesticIndex } from './src/kis/rest.js';
for (const [c, l] of [['0001','코스피'],['1001','코스닥']] as Array<[string,string]>) {
  for (let i = 0; i < 3; i++) {
    try {
      const q = await getDomesticIndex(c);
      console.log(`${l} ${q.value} (${q.changeRate}%) 상승${q.advancing}/하락${q.declining}`);
      break;
    } catch (e) {
      if (i === 2) console.log(`${l} 조회실패(3회) ${(e as Error).message}`);
      else await new Promise(r => setTimeout(r, 1500));
    }
  }
}
