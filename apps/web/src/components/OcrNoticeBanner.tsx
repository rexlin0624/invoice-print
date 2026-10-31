import { ocrMissingCount } from '../lib/ocrNotice';
import { useStore } from '../state/store';

/**
 * 扫描件只靠二维码识别、字段残缺时挑明原因。
 * 原来这条提示只藏在「更多设置」抽屉里，用户看到的却是「销售方未识别」，
 * 猜不到是没装模型 —— 所以放到结果区，一点就到安装说明。
 */
export function OcrNoticeBanner() {
  const { state, dispatch } = useStore();
  const count = ocrMissingCount(state.items, state.prefs.ocr);
  if (count === 0) return null;
  return (
    <div className="banner warn" role="status">
      <span>
        {count} 张扫描件 / 图片只取到二维码里的号码、金额、日期 ——
        这台电脑还没装离线 OCR 中文模型，装上才能把销售方、品名认全。
      </span>
      <span className="spacer" />
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => dispatch({ type: 'drawer', open: true })}
      >
        查看安装说明
      </button>
    </div>
  );
}
