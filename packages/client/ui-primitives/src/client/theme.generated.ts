/**
 * 官方主题的 `--dsw-*` token 全集（359 个），由 packages/client/ui-primitives/scripts/gen-design-tokens.mts 生成，勿手改。
 *
 * 叶子是该变量的**默认值**（官方 light 主题里首次出现的定义）：既是类型推导的来源，也可作 fallback。
 * `"$"` 键出现在「自身也是 token 的分支」上（命名体系里有 40 个短名同时是长名前缀的 token）。
 * 消费时只需树形状——`Token.vars()` 生成 `var(--dsw-…)`，不重新定义变量。
 * 漂移、往返与默认值完整性由 src/__tests__/design-tokens.spec.ts 守卫。 */
export const designTokens = {
  "alias": {
      "bg": {
          "base": "var(--dsw-static-neutral-bluish-00)",
          "document": {
              "preview": "var(--dsw-static-neutral-bluish-750)",
          },
          "layer": {
              "1": "var(--dsw-static-neutral-bluish-00)",
              "2": "var(--dsw-static-neutral-bluish-00)",
              "3": "var(--dsw-static-neutral-bluish-00)",
          },
          "mask": {
              "1": "rgba(0, 0, 0, 0.24)",
              "2": "rgba(0, 0, 0, 0.12)",
              "3": "rgba(0, 0, 0, 0.48)",
              "drop": "rgba(255, 255, 255, 0.7)",
              "photo": "rgba(0, 0, 0, 0.88)",
          },
          "module": {
              "platform": "var(--dsw-static-neutral-bluish-60)",
          },
          "multi": {
              "select": "var(--dsw-static-neutral-bluish-60)",
          },
          "overlay": "var(--dsw-static-neutral-bluish-150)",
          "skeleton": "rgba(0, 0, 0, 0.04)",
      },
      "border": {
          "inverted": "rgba(0, 0, 0, 0)",
          "inverted2": "rgba(0, 0, 0, 0)",
          "l1": "rgba(0, 0, 0, 0.04)",
          "l2": {
              "$": "rgba(0, 0, 0, 0.1)",
              "darkmode": {
                  "thin": "rgba(0, 0, 0, 0.1)",
              },
          },
          "l3": "rgba(0, 0, 0, 0.12)",
          "l4": "rgba(0, 0, 0, 0.16)",
      },
      "brand": {
          "primary": {
              "$": "var(--dsw-static-neutral-bluish-1000)",
              "invert": "var(--dsw-static-neutral-bluish-1000)",
              "new": {
                  "colorprimary": {
                      "new": {
                          "color": "rgb(65, 118, 230)",
                      },
                  },
              },
          },
          "text": "var(--dsw-static-neutral-bluish-1000)",
      },
      "button": {
          "contrast": {
              "fill": "var(--dsw-static-neutral-bluish-700)",
          },
          "elevated": {
              "fill": "var(--dsw-static-neutral-bluish-00)",
          },
          "floating": {
              "fill": "var(--dsw-static-neutral-bluish-00)",
              "hover": "var(--dsw-static-neutral-bluish-75)",
          },
          "ghost": {
              "active": {
                  "border": "var(--dsw-static-neutral-bluish-500)",
                  "fill": "var(--dsw-static-neutral-bluish-100)",
                  "hover": "var(--dsw-static-neutral-bluish-150)",
              },
          },
          "info": {
              "fill": "var(--dsw-static-deepseek-500)",
              "hover": "var(--dsw-static-deepseek-400)",
          },
          "primary": {
              "dimmed": "var(--dsw-static-neutral-bluish-100)",
              "fill": "var(--dsw-alias-brand-primary)",
              "hover": "var(--dsw-static-neutral-bluish-750)",
          },
          "tool": {
              "bar": {
                  "fill": {
                      "$": "rgba(84, 85, 87, 0.5)",
                      "invisible": "rgba(31, 31, 31, 0.36)",
                  },
                  "hover": "rgba(84, 85, 87, 0.6)",
              },
          },
      },
      "interactive": {
          "bg": {
              "active": "rgba(38, 49, 72, 0.1)",
              "hover": {
                  "$": "rgba(38, 49, 72, 0.06)",
                  "accent": "rgba(38, 49, 72, 0.14)",
                  "danger": "rgba(236, 19, 19, 0.05)",
                  "solid": "var(--dsw-static-neutral-bluish-75)",
              },
          },
      },
      "label": {
          "caption": "var(--dsw-static-neutral-bluish-400)",
          "dimmed": "var(--dsw-static-neutral-bluish-200)",
          "document": {
              "preview": "var(--dsw-static-neutral-bluish-200)",
          },
          "primary": {
              "$": "var(--dsw-static-neutral-bluish-1000)",
              "bluish": "var(--dsw-static-blue-900)",
              "dimmed": "var(--dsw-static-neutral-bluish-950)",
              "foreground": "var(--dsw-static-neutral-bluish-00)",
              "inverted": "var(--dsw-static-neutral-bluish-00)",
          },
          "secondary": "var(--dsw-static-neutral-bluish-700)",
          "tertiary": "var(--dsw-static-neutral-bluish-600)",
      },
      "link": "var(--dsw-static-deepseek-500)",
      "markdown": {
          "citation": "var(--dsw-static-neutral-bluish-100)",
          "code": {
              "block": {
                  "$": "var(--dsw-static-neutral-bluish-50)",
                  "banner": "var(--dsw-static-neutral-bluish-50)",
              },
              "segment": {
                  "selected": "var(--dsw-static-neutral-bluish-00)",
                  "unselected": "var(--dsw-static-neutral-bluish-75)",
              },
          },
          "inline": {
              "code": "var(--dsw-static-neutral-50)",
          },
          "placeholder": "var(--dsw-static-neutral-bluish-60)",
          "tag": "var(--dsw-static-neutral-bluish-75)",
      },
      "scrollbar": {
          "bg": {
              "l1": "var(--dsw-static-neutral-200)",
              "l2": "var(--dsw-static-neutral-200)",
          },
          "hover": {
              "l1": "var(--dsw-static-neutral-300)",
              "l2": "var(--dsw-static-neutral-300)",
          },
      },
      "state": {
          "business": {
              "primary": "var(--dsw-static-deepseek-500)",
              "tertiary": "var(--dsw-static-deepseek-100)",
          },
          "error": {
              "primary": "var(--dsw-static-red-600)",
              "secondary": "var(--dsw-static-red-400)",
          },
          "success": {
              "primary": "var(--dsw-static-green-500)",
              "secondary": "var(--dsw-static-green-400)",
              "tertiary": "var(--dsw-static-green-100)",
          },
          "warn": {
              "label": "var(--dsw-static-amber-600)",
              "primary": "var(--dsw-static-amber-500)",
              "secondary": "var(--dsw-static-amber-400)",
              "tertiary": "var(--dsw-static-amber-100)",
          },
      },
      "toast": {
          "bg": "var(--dsw-static-neutral-bluish-800)",
      },
      "tooltip": {
          "bg": "var(--dsw-static-neutral-bluish-850)",
      },
  },
  "corner": {
      "shape": "superellipse(1.5)",
  },
  "elevation": {
      "panel": "var(--dsw-elevation-stroke), 0 3px 8px 0 rgba(0, 0, 0, 0.03), 0 0 16px 0 rgba(0, 0, 0, 0.02)",
      "prominent": "var(--dsw-elevation-stroke), 0 3px 8px 0 rgba(0, 0, 0, 0.04), 0 0 20px 0 rgba(0, 0, 0, 0.05)",
      "soft": "var(--dsw-elevation-stroke), 0 4px 16px 0 rgba(0, 0, 0, 0.03), 0 0 24px 0 rgba(0, 0, 0, 0.03)",
      "stroke": {
          "$": "0 0 0 0.5px var(--dsw-elevation-stroke-color)",
          "color": "var(--dsw-alias-border-l4)",
      },
  },
  "font": {
      "base": {
          "16": {
              "$": "16px/24px var(--dsw-font-family)",
              "font": {
                  "family": "var(--dsw-font-family)",
                  "size": "16px",
                  "style": "normal",
                  "weight": "400",
              },
              "line": {
                  "height": "24px",
              },
          },
          "strong": {
              "16": {
                  "$": "500 16px/24px var(--dsw-font-family)",
                  "font": {
                      "family": "var(--dsw-font-family)",
                      "size": "16px",
                      "style": "normal",
                      "weight": "500",
                  },
                  "line": {
                      "height": "24px",
                  },
              },
          },
      },
      "family": "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',\n    'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif",
      "l": {
          "20": {
              "$": "500 20px/28px var(--dsw-font-family)",
              "font": {
                  "family": "var(--dsw-font-family)",
                  "size": "20px",
                  "style": "normal",
                  "weight": "500",
              },
              "line": {
                  "height": "28px",
              },
          },
      },
      "m": {
          "18": {
              "$": "500 16px/28px var(--dsw-font-family)",
              "font": {
                  "family": "var(--dsw-font-family)",
                  "size": "16px",
                  "style": "normal",
                  "weight": "500",
              },
              "line": {
                  "height": "28px",
              },
          },
      },
      "markdown": {
          "base": {
              "$": "var(--dsh-content-font-size, 14px) / calc(24px + var(--dsh-content-font-delta)) var(--dsw-font-family)",
              "font": {
                  "family": "var(--dsw-font-family)",
                  "size": "var(--dsh-content-font-size, 14px)",
                  "style": "normal",
                  "weight": "400",
              },
              "italic": {
                  "$": "italic var(--dsh-content-font-size, 14px) / calc(24px + var(--dsh-content-font-delta)) var(--dsw-font-family)",
                  "font": {
                      "family": "var(--dsw-font-family)",
                      "size": "var(--dsh-content-font-size, 14px)",
                      "style": "italic",
                      "weight": "400",
                  },
                  "line": {
                      "height": "calc(24px + var(--dsh-content-font-delta))",
                  },
              },
              "line": {
                  "height": "calc(24px + var(--dsh-content-font-delta))",
              },
              "strong": {
                  "$": "600 var(--dsh-content-font-size, 14px) / calc(24px + var(--dsh-content-font-delta)) var(--dsw-font-family)",
                  "font": {
                      "family": "var(--dsw-font-family)",
                      "size": "var(--dsh-content-font-size, 14px)",
                      "style": "normal",
                      "weight": "600",
                  },
                  "italic": {
                      "$": "italic 600 var(--dsh-content-font-size, 14px) / calc(24px + var(--dsh-content-font-delta)) var(--dsw-font-family)",
                      "font": {
                          "family": "var(--dsw-font-family)",
                          "size": "var(--dsh-content-font-size, 14px)",
                          "style": "italic",
                          "weight": "600",
                      },
                      "line": {
                          "height": "calc(24px + var(--dsh-content-font-delta))",
                      },
                  },
                  "line": {
                      "height": "calc(24px + var(--dsh-content-font-delta))",
                  },
              },
          },
          "code": {
              "$": "12px/19px var(--ds-font-family-code)",
              "block": {
                  "$": "11px/19px var(--ds-font-family-code)",
                  "font": {
                      "family": "var(--ds-font-family-code)",
                      "size": "11px",
                      "style": "normal",
                      "weight": "400",
                  },
                  "line": {
                      "height": "19px",
                  },
                  "small": {
                      "$": "11px/16px var(--ds-font-family-code)",
                      "font": {
                          "family": "var(--ds-font-family-code)",
                          "size": "11px",
                          "style": "normal",
                          "weight": "400",
                      },
                      "line": {
                          "height": "16px",
                      },
                  },
              },
              "font": {
                  "family": "var(--ds-font-family-code)",
                  "size": "12px",
                  "style": "normal",
                  "weight": "400",
              },
              "line": {
                  "height": "19px",
              },
          },
          "h1": {
              "$": "700 calc(21px + var(--dsh-content-font-delta)) / calc(30px + var(--dsh-content-font-delta)) var(--dsw-font-family)",
              "font": {
                  "family": "var(--dsw-font-family)",
                  "size": "calc(21px + var(--dsh-content-font-delta))",
                  "style": "normal",
                  "weight": "700",
              },
              "line": {
                  "height": "calc(30px + var(--dsh-content-font-delta))",
              },
          },
          "h2": {
              "$": "700 calc(19px + var(--dsh-content-font-delta)) / calc(28px + var(--dsh-content-font-delta)) var(--dsw-font-family)",
              "font": {
                  "family": "var(--dsw-font-family)",
                  "size": "calc(19px + var(--dsh-content-font-delta))",
                  "style": "normal",
                  "weight": "700",
              },
              "line": {
                  "height": "calc(28px + var(--dsh-content-font-delta))",
              },
          },
          "h3": {
              "$": "700 calc(18px + var(--dsh-content-font-delta)) / calc(26px + var(--dsh-content-font-delta)) var(--dsw-font-family)",
              "font": {
                  "family": "var(--dsw-font-family)",
                  "size": "calc(18px + var(--dsh-content-font-delta))",
                  "style": "normal",
                  "weight": "700",
              },
              "line": {
                  "height": "calc(26px + var(--dsh-content-font-delta))",
              },
          },
          "h4": {
              "$": "600 var(--dsh-content-font-size, 14px) / calc(24px + var(--dsh-content-font-delta)) var(--dsw-font-family)",
              "font": {
                  "family": "var(--dsw-font-family)",
                  "size": "var(--dsh-content-font-size, 14px)",
                  "style": "normal",
                  "weight": "600",
              },
              "line": {
                  "height": "calc(24px + var(--dsh-content-font-delta))",
              },
          },
          "small": {
              "$": "12px/20px var(--dsw-font-family)",
              "font": {
                  "family": "var(--dsw-font-family)",
                  "size": "12px",
                  "style": "normal",
                  "weight": "400",
              },
              "italic": {
                  "$": "italic 12px/20px var(--dsw-font-family)",
                  "font": {
                      "family": "var(--dsw-font-family)",
                      "size": "12px",
                      "style": "italic",
                      "weight": "400",
                  },
                  "line": {
                      "height": "20px",
                  },
              },
              "line": {
                  "height": "20px",
              },
              "strong": {
                  "$": "600 12px/20px var(--dsw-font-family)",
                  "font": {
                      "family": "var(--dsw-font-family)",
                      "size": "12px",
                      "style": "normal",
                      "weight": "600",
                  },
                  "italic": {
                      "$": "italic 600 12px/20px var(--dsw-font-family)",
                      "font": {
                          "family": "var(--dsw-font-family)",
                          "size": "12px",
                          "style": "italic",
                          "weight": "600",
                      },
                      "line": {
                          "height": "20px",
                      },
                  },
                  "line": {
                      "height": "20px",
                  },
              },
          },
          "table": {
              "$": "var(--dsh-content-font-size-secondary, 13px)/calc(22px + var(--dsh-content-font-delta-secondary, 0px)) var(--dsw-font-family)",
              "font": {
                  "family": "var(--dsw-font-family)",
                  "size": "var(--dsh-content-font-size-secondary, 13px)",
                  "style": "normal",
                  "weight": "400",
              },
              "head": {
                  "$": "500 var(--dsh-content-font-size-secondary, 13px)/calc(22px + var(--dsh-content-font-delta-secondary, 0px)) var(--dsw-font-family)",
                  "font": {
                      "family": "var(--dsw-font-family)",
                      "size": "var(--dsh-content-font-size-secondary, 13px)",
                      "style": "normal",
                      "weight": "500",
                  },
                  "line": {
                      "height": "calc(22px + var(--dsh-content-font-delta-secondary, 0px))",
                  },
              },
              "line": {
                  "height": "calc(22px + var(--dsh-content-font-delta-secondary, 0px))",
              },
          },
      },
      "s": {
          "14": {
              "$": "14px/22px var(--dsw-font-family)",
              "font": {
                  "family": "var(--dsw-font-family)",
                  "size": "14px",
                  "style": "normal",
                  "weight": "400",
              },
              "line": {
                  "height": "22px",
              },
          },
          "strong": {
              "14": {
                  "$": "500 14px/22px var(--dsw-font-family)",
                  "font": {
                      "family": "var(--dsw-font-family)",
                      "size": "14px",
                      "style": "normal",
                      "weight": "500",
                  },
                  "line": {
                      "height": "22px",
                  },
              },
          },
      },
      "xl": {
          "24": {
              "$": "600 24px/32px var(--dsw-font-family)",
              "font": {
                  "family": "var(--dsw-font-family)",
                  "size": "24px",
                  "style": "normal",
                  "weight": "600",
              },
              "line": {
                  "height": "32px",
              },
          },
      },
      "xs": {
          "13": {
              "$": "13px/20px var(--dsw-font-family)",
              "font": {
                  "family": "var(--dsw-font-family)",
                  "size": "13px",
                  "style": "normal",
                  "weight": "400",
              },
              "line": {
                  "height": "20px",
              },
          },
          "strong": {
              "13": {
                  "$": "500 13px/20px var(--dsw-font-family)",
                  "font": {
                      "family": "var(--dsw-font-family)",
                      "size": "13px",
                      "style": "normal",
                      "weight": "500",
                  },
                  "line": {
                      "height": "20px",
                  },
              },
          },
      },
      "xxs": {
          "12": {
              "$": "12px/18px var(--dsw-font-family)",
              "font": {
                  "family": "var(--dsw-font-family)",
                  "size": "12px",
                  "style": "normal",
                  "weight": "400",
              },
              "line": {
                  "height": "18px",
              },
          },
          "strong": {
              "12": {
                  "$": "500 12px/18px var(--dsw-font-family)",
                  "font": {
                      "family": "var(--dsw-font-family)",
                      "size": "12px",
                      "style": "normal",
                      "weight": "500",
                  },
                  "line": {
                      "height": "18px",
                  },
              },
          },
      },
      "xxxs": {
          "11": {
              "$": "11px/14px var(--dsw-font-family)",
              "font": {
                  "family": "var(--dsw-font-family)",
                  "size": "11px",
                  "style": "normal",
                  "weight": "400",
              },
              "line": {
                  "height": "14px",
              },
          },
          "strong": {
              "11": {
                  "$": "500 11px/14px var(--dsw-font-family)",
                  "font": {
                      "family": "var(--dsw-font-family)",
                      "size": "11px",
                      "style": "normal",
                      "weight": "500",
                  },
                  "line": {
                      "height": "14px",
                  },
              },
          },
      },
  },
  "linear": {
      "gradient": {
          "think": "linear-gradient(180deg, #fff 20.19%, rgba(255, 255, 255, 0) 100%)",
      },
      "think": {
          "select": "linear-gradient(180deg, #f5f6f7 20.19%, rgba(245, 246, 247, 0) 100%)",
      },
  },
  "mask": {
      "blur": "blur(2px)",
  },
  "shadow": {
      "lv1": {
          "$": "0 2px 4px 0 rgba(0, 0, 0, 0.05)",
          "blur": "0 4px 12px 0 rgba(0, 0, 0, 0.02)",
      },
      "lv2": "0 4px 12px 0 rgba(0, 0, 0, 0.02), 0 2px 8px 0 rgba(0, 0, 0, 0.04)",
      "lv3": "0 0 1px 0 rgba(0, 0, 0, 0.2), 0 0 4px 0 rgba(0, 0, 0, 0.02), 0 12px 32px 0 rgba(0, 0, 0, 0.08)",
  },
  "specific": {
      "bubble": {
          "$": "var(--dsw-static-deepseek-50)",
          "highlight": "var(--dsw-static-deepseek-200)",
      },
      "input": {
          "major": "var(--dsw-static-neutral-bluish-00)",
      },
      "login": {
          "input": "var(--dsw-static-neutral-bluish-50)",
      },
      "menu": "var(--dsw-alias-bg-layer-3)",
      "selector": "var(--dsw-static-neutral-bluish-60)",
      "sidebar": {
          "fill": "var(--dsw-static-neutral-bluish-50)",
          "nav": {
              "item": {
                  "active": {
                      "$": "var(--dsw-static-neutral-bluish-100)",
                      "accent": "var(--dsw-static-deepseek-100)",
                  },
                  "hover": "var(--dsw-static-neutral-bluish-75)",
              },
          },
      },
      "tip": "var(--dsw-static-neutral-bluish-60)",
  },
  "static": {
      "amber": {
          "100": "rgb(254, 245, 231)",
          "400": "rgb(247, 173, 49)",
          "500": "rgb(245, 158, 11)",
          "600": "rgb(221, 134, 41)",
          "900": "rgb(39, 36, 31)",
      },
      "blue": {
          "50": "rgb(239, 246, 255)",
          "75": "rgb(229, 240, 255)",
          "100": "rgb(219, 234, 254)",
          "300": "rgb(147, 197, 253)",
          "400": "rgb(96, 165, 250)",
          "450": "rgb(77, 147, 248)",
          "500": "rgb(59, 130, 246)",
          "600": "rgb(37, 99, 235)",
          "800": "rgb(30, 64, 175)",
          "900": "rgb(14, 48, 116)",
          "950": "rgb(23, 37, 84)",
          "50p": "rgb(234, 243, 255)",
      },
      "deepseek": {
          "50": "rgb(237, 243, 254)",
          "100": "rgb(228, 237, 253)",
          "200": "rgb(211, 226, 255)",
          "300": "rgb(183, 200, 254)",
          "400": "rgb(103, 158, 254)",
          "450": "rgb(86, 134, 254)",
          "500": "rgb(65, 118, 230)",
          "600": "rgb(72, 104, 178)",
          "700": {
              "delete": "rgb(47, 76, 143)",
          },
          "800": "rgb(52, 65, 91)",
          "900": "rgb(40, 49, 66)",
      },
      "green": {
          "100": "rgb(230, 250, 237)",
          "400": "rgb(78, 209, 126)",
          "500": "rgb(34, 197, 94)",
          "900": "rgb(35, 60, 44)",
      },
      "neutral": {
          "50": "rgb(250, 250, 250)",
          "100": "rgb(245, 245, 245)",
          "150": "rgb(237, 237, 237)",
          "200": "rgb(229, 229, 229)",
          "250": "rgb(220, 220, 220)",
          "300": "rgb(212, 212, 212)",
          "400": "rgb(162, 164, 166)",
          "500": "rgb(127, 130, 135)",
          "550": "rgb(101, 103, 107)",
          "600": "rgb(84, 85, 87)",
          "700": "rgb(60, 60, 61)",
          "800": "rgb(41, 41, 41)",
          "850": "rgb(33, 33, 35)",
          "900": "rgb(15, 15, 15)",
          "1000": "rgb(0, 0, 0)",
          "00": "rgb(255, 255, 255)",
          "bluish": {
              "50": "rgb(249, 250, 251)",
              "60": "rgb(245, 246, 247)",
              "75": "rgb(241, 243, 245)",
              "100": "rgb(235, 238, 242)",
              "150": "rgb(233, 236, 242)",
              "200": "rgb(225, 229, 238)",
              "300": "rgb(207, 211, 214)",
              "400": "rgb(173, 178, 184)",
              "500": "rgb(151, 157, 166)",
              "600": "rgb(129, 133, 140)",
              "700": "rgb(97, 102, 107)",
              "750": "rgb(67, 69, 74)",
              "800": "rgb(53, 54, 56)",
              "850": "rgb(44, 44, 46)",
              "875": "rgb(35, 35, 36)",
              "900": "rgb(27, 27, 28)",
              "950": "rgb(21, 21, 23)",
              "1000": "rgb(15, 17, 21)",
              "00": "rgb(255, 255, 255)",
          },
      },
      "red": {
          "50": "rgb(254, 242, 242)",
          "100": "rgb(254, 226, 226)",
          "400": "rgb(242, 90, 90)",
          "500": "rgb(239, 68, 68)",
          "600": "rgb(236, 19, 19)",
          "900": "rgb(87, 12, 12)",
      },
  },
} as const
