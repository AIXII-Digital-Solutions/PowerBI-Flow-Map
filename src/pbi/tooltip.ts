import { Selection } from 'd3-selection';
import powerbi from "powerbi-visuals-api";
import { Context } from '.';
import * as pbi from 'powerbi-visuals-utils-tooltiputils';

type Any<T = any> = Selection<any, T, any, any>;
type VisualTooltipDataItem = powerbi.extensibility.VisualTooltipDataItem;

export module tooltip {
  let service = null as pbi.ITooltipServiceWrapper;

  export function init(options: powerbi.extensibility.visual.VisualConstructorOptions) {
    service = pbi.createTooltipServiceWrapper(options.host.tooltipService, options.element);
  }

  // In tooltiputils >= 3.x the delegate receives the bound datum directly (not a
  // TooltipEventArgs wrapper), so callers read fields off the datum itself.
  export function add<T>(selection: Any<T>, getTooltipInfoDelegate: (datapoint: T) => VisualTooltipDataItem[]) {
    service.addTooltip(selection, getTooltipInfoDelegate);
  }

  export function hide() {
    service.hide();
  }

  export function item(value: any, displayName?: string, header?: string, color?: string): VisualTooltipDataItem {
    return { value, displayName, header, color };
  }

  export function build<R extends string, T extends R>(ctx: Context<R, any>, role: T, row: number) {
    const columns = ctx.columns(role);
    if (!columns || !columns.length) {
      return null;
    }
    return columns.map(c => item(c.values[row], c.source.displayName));
  }
}