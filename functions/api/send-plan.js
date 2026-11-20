import mod from '../_lib/send-plan.js';
import { run } from '../_lib/adapt.js';
export const onRequest = (ctx) => run(mod, ctx);
