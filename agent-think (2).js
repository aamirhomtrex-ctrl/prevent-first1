import mod from '../_lib/agent-think.js';
import { run } from '../_lib/adapt.js';
export const onRequest = (ctx) => run(mod, ctx);
