import { EventEmitter } from 'node:events';

// ناقل أحداث داخل العملية. الرسائل تلميحات "تغيّر شيء، أعد الجلب" وليست مصدر الحقيقة؛
// قاعدة البيانات هي المصدر، والعملاء يعيدون الجلب عند الاتصال أو عند أي إشعار.
export class Bus extends EventEmitter {
  constructor() { super(); this.setMaxListeners(0); }
  branch(branchId, data) { this.emit(`branch:${branchId}`, data); }
  order(orderId, data) { this.emit(`order:${orderId}`, data); }
}
