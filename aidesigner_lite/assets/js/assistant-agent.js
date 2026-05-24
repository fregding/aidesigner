(function attachAssistantAgent(global) {
    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function encodeData(value) {
        return encodeURIComponent(value || '');
    }

    function normalizeEscapedWhitespace(value) {
        return String(value == null ? '' : value)
            .replace(/\\r\\n/g, '\n')
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\n')
            .replace(/\\t/g, '    ');
    }

    function stripInternalVisibleLines(value) {
        var internalFieldNames = '(?:apply_text|ready_to_generate|search_query|search_results|uploaded_images|uploaded_documents|current_draft|user_request|resource_reading|deliverables|ppt_master_template|pptMasterTemplate|pptMaster|ppt_master)';
        var internalFieldPattern = new RegExp("^(?:[-*]\\s*)?[\"']?" + internalFieldNames + "[\"']?\\s*:?\\s*(?:[,}\\]]\\s*)?$", 'i');
        var internalKeyValuePattern = new RegExp("^(?:[-*]\\s*)?[\"']?" + internalFieldNames + "[\"']?\\s*[:=]", 'i');
        return String(value == null ? '' : value)
            .split('\n')
            .filter(function(line) {
                var text = line.trim();
                return !internalFieldPattern.test(text) && !internalKeyValuePattern.test(text);
            })
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function scrubInternalText(value) {
        return stripInternalVisibleLines(normalizeEscapedWhitespace(value)
            .replace(/Step\s*1\s*Source\s*Content\s*Processing\s*完成/gi, '内容已整理')
            .replace(/Step\s*2\s*Project\s*Initialization\s*完成/gi, 'PPT 项目已创建')
            .replace(/Step\s*3\s*Template\s*Option\s*完成/gi, '设计风格已确定')
            .replace(/Step\s*4\s*Strategist\s*完成/gi, '页面结构已整理')
            .replace(/Step\s*5\s*Image_Generator\s*完成/gi, '配图已准备')
            .replace(/Step\s*6\s*Executor\s*Visual\s*Construction\s*完成/gi, 'PPT 页面已生成')
            .replace(/Step\s*6\s*Quality\s*Check\s*Gate\s*完成/gi, '页面效果已检查')
            .replace(/Step\s*6\s*Chart\s*Calibration\s*Gate\s*完成/gi, '图表已检查')
            .replace(/Step\s*6\s*Logic\s*Construction\s*完成/gi, '备注已生成')
            .replace(/Step\s*7\.1\s*Split\s*Speaker\s*Notes\s*完成/gi, '备注已整理')
            .replace(/Step\s*7\.2\s*Finalize\s*SVG\s*完成/gi, '页面文件已整理')
            .replace(/Step\s*7\.3\s*Export\s*PPTX\s*完成/gi, 'PPT 文件已生成')
            .replace(/正在执行\s*Step\s*1\s*Source\s*Content\s*Processing/gi, '正在整理内容')
            .replace(/正在执行\s*Step\s*2\s*Project\s*Initialization/gi, '正在创建 PPT 项目')
            .replace(/正在执行\s*Step\s*3\s*Template\s*Option/gi, '正在选择设计风格')
            .replace(/正在执行\s*Step\s*4\s*Strategist/gi, '正在整理页面结构')
            .replace(/正在执行\s*Step\s*5\s*Image_Generator/gi, '正在准备配图')
            .replace(/正在执行\s*Step\s*6\s*Executor\s*Visual\s*Construction/gi, '正在生成 PPT 页面')
            .replace(/正在执行\s*Step\s*6\s*Quality\s*Check\s*Gate/gi, '正在检查页面效果')
            .replace(/正在执行\s*Step\s*6\s*Chart\s*Calibration\s*Gate/gi, '正在检查图表显示')
            .replace(/正在执行\s*Step\s*6\s*Logic\s*Construction/gi, '正在生成演讲备注')
            .replace(/正在执行\s*Step\s*7\.1\s*Split\s*Speaker\s*Notes/gi, '正在整理演讲备注')
            .replace(/正在执行\s*Step\s*7\.2\s*Finalize\s*SVG/gi, '正在整理页面文件')
            .replace(/正在执行\s*Step\s*7\.3\s*Export\s*PPTX/gi, '正在生成 PPT 文件')
            .replace(/Step\s*1\s*[：:]\s*整理源内容并补充联网资料/g, '正在整理内容并补充资料')
            .replace(/Step\s*1\s*[：:]\s*整理用户源内容/g, '正在整理你提供的内容')
            .replace(/Step\s*2\s*[：:]\s*初始化\s*PPT\s*项目并导入内容/g, '正在创建 PPT 项目')
            .replace(/Step\s*2\s*[：:]\s*PPT\s*项目已创建/g, 'PPT 项目已创建，正在继续生成')
            .replace(/Step\s*3\s*[：:][^\n。；;]*(?:模板|free design|gate)[^\n。；;]*/gi, '正在选择合适的设计风格')
            .replace(/Step\s*5\s*[：:][^\n。；;]*(?:design_spec|图片策略|准备资源)[^\n。；;]*/gi, '正在准备配图')
            .replace(/Step\s*6\s*[：:]\s*正在检查页面质量并自动修复/g, '正在检查页面效果')
            .replace(/Step\s*6\s*[：:]\s*正在执行强制图表坐标校准\s*gate/gi, '正在检查图表显示')
            .replace(/Step\s*7\.1\s*[：:]\s*正在执行\s*total_md_split\.py/gi, '正在整理演讲备注')
            .replace(/Step\s*7\.2\s*[：:]\s*正在执行\s*finalize_svg\.py/gi, '正在整理页面文件')
            .replace(/Step\s*7\.3\s*[：:]\s*正在执行\s*svg_to_pptx\.py\s*-s\s*final\s*导出\s*PPTX/gi, '正在生成可下载的 PPT 文件')
            .replace(/(?:total_md_split|finalize_svg|svg_to_pptx)\.py(?:\s+-s\s+\w+)?/gi, '生成工具')
            .replace(/\binspect\s*·\s*/gi, '')
            .replace(/\bselect\s*·\s*/gi, '')
            .replace(/\bpropose\s*·\s*/gi, '')
            .replace(/\bapply\s*·\s*/gi, '')
            .replace(/\bexport\s*·\s*/gi, '')
            .replace(/(?:正在执行)?\s*Step\s*\d+(?:\.\d+)?\s*[A-Z][A-Za-z_\s-]*/g, '正在处理')
            .replace(/\bStrategist\b/gi, '内容规划')
            .replace(/\bExecutor\b/gi, '页面生成')
            .replace(/\bImage_Generator\b/gi, '配图准备')
            .replace(/\bgate\b/gi, '检查')
            .replace(/(?:再)?交给\s*(?:ppt[-\s_]*master|PPT\s*Master)\s*生成/gi, '开始生成')
            .replace(/换一个\s*(?:ppt[-\s_]*master|PPT\s*Master)\s*模板/gi, '换一个推荐风格')
            .replace(/ppt[-\s_]*master\s*模板\s*[：:]\s*[^\n。；;]*/gi, '推荐风格已匹配')
            .replace(/ppt[-\s_]*master\s*自由设计/gi, '自由设计')
            .replace(/ppt[-\s_]*master\s*模板/gi, '推荐风格')
            .replace(/PPT\s*Master\s*模板/gi, '推荐风格')
            .replace(/ppt[-\s_]*master/gi, '生成服务')
            .replace(/PPT\s*Master/gi, '生成服务')
            .replace(/ppt_master_template/gi, '推荐风格')
            .replace(/pptMasterTemplate/g, '推荐风格')
            .replace(/正在调用大模型/g, '正在整理方案')
            .replace(/调用大模型判断意图/g, '理解修改需求')
            .replace(/模型流式输出/g, '整理回复')
            .replace(/大模型/g, 'AI')
            .replace(/PPT\s*Agent/gi, 'PPT 生成服务'));
    }

    var AGENT_STEP_LABELS = {
        analysis: '理解需求',
        search: '检索资料',
        compose: '整理内容',
        inspect: '检查当前 PPT',
        select: '定位修改页面',
        propose: '生成修改提案',
        apply: '应用修改',
        export: '重新导出',
        done: '完成'
    };

    var AGENT_STATUS_LABELS = {
        pending: '等待',
        running: '进行中',
        processing: '进行中',
        completed: '完成',
        complete: '完成',
        done: '完成',
        success: '完成',
        failed: '失败',
        error: '失败',
        skipped: '跳过'
    };

    var AGENT_KIND_ALIASES = {
        workspace_snapshot: 'inspect',
        inspect_workspace: 'inspect',
        read_deck: 'inspect',
        read_slide: 'inspect',
        intent_judgement: 'select',
        intent_judgment: 'select',
        select_pages: 'select',
        resolve_target_pages: 'select',
        create_proposal: 'propose',
        proposal: 'propose',
        apply_proposal: 'apply',
        apply_ppt_proposal: 'apply'
    };

    function normalizeAgentKind(value) {
        var kind = String(value || 'step').trim().toLowerCase().replace(/\s+/g, '_') || 'step';
        return AGENT_KIND_ALIASES[kind] || kind;
    }

    function summarizeAgentTarget(step) {
        if (!step || typeof step !== 'object') return '';
        if (Array.isArray(step.pages) && step.pages.length > 0) {
            return '页面：' + step.pages.map(function(page) {
                return String(page);
            }).join('、');
        }
        if (Array.isArray(step.target_pages) && step.target_pages.length > 0) {
            return '页面：' + step.target_pages.map(function(page) {
                return String(page);
            }).join('、');
        }
        if (step.page) return '页面：' + step.page;
        if (step.pageIndex !== undefined && step.pageIndex !== null && Number.isFinite(Number(step.pageIndex))) return '页面：' + (Number(step.pageIndex) + 1);
        if (step.target) return String(step.target);
        return '';
    }

    function normalizeAgentStep(step, index) {
        var source = step && typeof step === 'object' ? step : { label: step };
        var kind = normalizeAgentKind(source.kind || source.type || source.action || source.name || source.id);
        var rawStatus = source.status || source.state || (source.error ? 'error' : source.done ? 'done' : '');
        var status = String(rawStatus || '').trim().toLowerCase().replace(/\s+/g, '_');
        var detail = source.summary || source.detail || source.message || source.description || source.reason || summarizeAgentTarget(source);
        return {
            kind: kind,
            status: status,
            label: scrubInternalText(source.label || source.title || AGENT_STEP_LABELS[kind] || ('步骤 ' + (index + 1))),
            detail: scrubInternalText(detail || ''),
            rawKind: source.kind || source.type || source.action || source.name || kind
        };
    }

    function inferPendingSteps(workspace, text) {
        var steps = [
            {
                kind: 'analysis',
                label: '乐米正在理解需求',
                detail: workspace === 'image'
                    ? '判断是否需要生成方案'
                    : workspace === 'ppt'
                    ? '拆解主题、受众和页级结构'
                    : workspace === 'video'
                    ? '拆解节奏、镜头和脚本目标'
                    : '拆解任务类型和交付方式'
            }
        ];

        steps.push({
            kind: 'compose',
            label: '乐米正在整理交付内容',
            detail: workspace === 'image'
                ? '整理回复或可确认提示词'
                : workspace === 'ppt'
                ? '准备标题、大纲和表达重点'
                : workspace === 'video'
                ? '准备脚本、分镜和口播节奏'
                : '准备可直接使用的内容'
        });

        return steps;
    }

    function inferPptCopilotSteps(text, options) {
        var query = String(text || '').trim();
        var pageIndex = options && Number.isFinite(Number(options.pageIndex)) ? Number(options.pageIndex) : null;
        var pageDetail = pageIndex !== null ? '当前预览第 ' + (pageIndex + 1) + ' 页' : '基于当前打开的 PPT';
        return [
            {
                kind: 'inspect',
                status: 'completed',
                label: 'inspect · 审阅当前 PPT',
                detail: pageDetail
            },
            {
                kind: 'select',
                status: 'completed',
                label: 'select · 定位修改范围',
                detail: query.length > 36 ? query.slice(0, 36) + '...' : (query || '根据上下文选择页面')
            },
            {
                kind: 'propose',
                status: 'completed',
                label: 'propose · 生成可审阅提案',
                detail: '先预览，确认后再写入原 PPT'
            }
        ];
    }

    function renderTrace(trace) {
        return '';
    }

    function renderAgentActions(actions) {
        return '';
    }

    function renderDeliverable(deliverable, options) {
        var applyButtonText = options && options.applyButtonText ? options.applyButtonText : '应用到输入框';
        var isPrimary = Boolean(options && options.isPrimary);
        var showApply = Boolean(options && options.showApply && deliverable.apply_text);
        var sectionClass = 'assistant-section' + (isPrimary ? ' assistant-section-primary' : '');
        var title = deliverable.label
            ? '<div class="assistant-section-title">' + escapeHtml(scrubInternalText(deliverable.label || '')) + '</div>'
            : '';
        var body = '';

        if (deliverable.content) {
            body += '<pre class="assistant-section-pre">' + escapeHtml(scrubInternalText(deliverable.content)) + '</pre>';
        }

        if (Array.isArray(deliverable.items) && deliverable.items.length > 0) {
            body += '<ul class="assistant-section-list">' + deliverable.items.map(function(item) {
                return '<li>' + escapeHtml(scrubInternalText(item)) + '</li>';
            }).join('') + '</ul>';
        }

        var action = '';
        if (showApply) {
            action = (
                '<div class="assistant-section-actions">' +
                    '<button class="assistant-apply-btn" data-assistant-action="apply" data-apply-text="' + encodeData(deliverable.apply_text) + '">' +
                        escapeHtml(applyButtonText) +
                    '</button>' +
                '</div>'
            );
        }

        return (
            '<section class="' + sectionClass + '">' +
                title +
                body +
                action +
            '</section>'
        );
    }

    function renderSuggestions(suggestions) {
        if (!Array.isArray(suggestions) || suggestions.length === 0) {
            return '';
        }

        return (
            '<div class="assistant-suggestion-wrap">' +
                '<div class="assistant-mini-title">你还可以补充</div>' +
                '<div class="suggestion-chips">' +
                    suggestions.map(function(item) {
                        return '<button class="suggestion-chip" data-assistant-action="suggest" data-suggestion="' + encodeData(item) + '">' + escapeHtml(scrubInternalText(item)) + '</button>';
                    }).join('') +
                '</div>' +
            '</div>'
        );
    }

    function renderSources(sources) {
        if (!Array.isArray(sources) || sources.length === 0) {
            return '';
        }

        return (
            '<div class="assistant-source-wrap">' +
                '<div class="assistant-mini-title">参考资料</div>' +
                '<div class="assistant-source-list">' +
                    sources.map(function(source) {
                        return (
                            '<a class="assistant-source-item" href="' + escapeHtml(source.url) + '" target="_blank" rel="noopener noreferrer">' +
                                '<span class="assistant-source-title">' + escapeHtml(scrubInternalText(source.title || source.url)) + '</span>' +
                                '<span class="assistant-source-snippet">' + escapeHtml(scrubInternalText(source.snippet || source.url)) + '</span>' +
                            '</a>'
                        );
                    }).join('') +
                '</div>' +
            '</div>'
        );
    }

    function renderImages(images, options) {
        if (!Array.isArray(images) || images.length === 0) {
            return '';
        }

        var imageActionText = options && options.imageActionText ? options.imageActionText : '';
        var enableImageApply = Boolean(imageActionText);

        return (
            '<div class="assistant-image-wrap">' +
                '<div class="assistant-mini-title">参考图</div>' +
                '<div class="assistant-image-grid">' +
                    images.map(function(item) {
                        var encodedUrl = encodeData(item.url);
                        var encodedDescription = encodeData(item.description || '');
                        var originalUrl = item.original_url || item.url;
                        return (
                            '<div class="assistant-image-card" draggable="' + (enableImageApply ? 'true' : 'false') + '" data-reference-image-src="' + encodedUrl + '" data-reference-image-label="' + encodedDescription + '">' +
                                '<a class="assistant-image-preview" href="' + escapeHtml(originalUrl) + '" target="_blank" rel="noopener noreferrer" data-fallback-label="' + escapeHtml(scrubInternalText(item.description || '参考图片')) + '">' +
                                    '<img src="' + escapeHtml(item.url) + '" alt="' + escapeHtml(scrubInternalText(item.description || '参考图片')) + '" loading="lazy" onerror="this.closest(\'.assistant-image-card\').classList.add(\'is-image-missing\'); this.remove();">' +
                                '</a>' +
                                '<span>' + escapeHtml(scrubInternalText(item.description || '打开参考图')) + '</span>' +
                                (
                                    enableImageApply
                                        ? '<div class="assistant-image-actions">' +
                                            '<button class="assistant-image-use-btn" type="button" data-assistant-action="use-image" data-image-url="' + encodedUrl + '" data-image-description="' + encodedDescription + '" aria-pressed="false">' + escapeHtml(imageActionText) + '</button>' +
                                            '<a class="assistant-image-link" href="' + escapeHtml(originalUrl) + '" target="_blank" rel="noopener noreferrer">查看原图</a>' +
                                          '</div>'
                                        : ''
                                ) +
                            '</div>'
                        );
                    }).join('') +
                '</div>' +
            '</div>'
        );
    }

    function renderAssistantPayload(payload, options) {
        var applyLabel = options && options.applyButtonText ? options.applyButtonText : '应用到输入框';
        var allowApply = !(options && options.showApply === false);
        var overview = payload && payload.overview ? scrubInternalText(payload.overview) : '我已经整理好了。';
        var deliverables = Array.isArray(payload && payload.deliverables)
            ? payload.deliverables.filter(function(item) {
                return item && (item.content || (Array.isArray(item.items) && item.items.length > 0));
            }).slice(0, 3)
            : [];
        var primaryApplyIndex = deliverables.findIndex(function(item) {
            return Boolean(item && item.apply_text);
        });
        return (
            '<div class="message-header">乐米</div>' +
            '<div class="assistant-overview">' + escapeHtml(overview) + '</div>' +
            deliverables.map(function(item, index) {
                return renderDeliverable(item, {
                    applyButtonText: applyLabel,
                    isPrimary: index === 0,
                    showApply: allowApply && index === primaryApplyIndex
                });
            }).join('') +
            renderSuggestions(payload && payload.suggestions) +
            renderSources(payload && payload.sources) +
            renderImages(payload && payload.images, options)
        );
    }

    function assistantToHistoryText(payload) {
        var parts = [];
        if (payload && payload.overview) {
            parts.push(scrubInternalText(payload.overview));
        }

        if (Array.isArray(payload && payload.deliverables)) {
            payload.deliverables.forEach(function(item) {
                if (item.label) {
                    parts.push(scrubInternalText(item.label) + ':');
                }
                if (item.content) {
                    parts.push(scrubInternalText(item.content));
                }
                if (Array.isArray(item.items) && item.items.length > 0) {
                    parts.push(item.items.map(scrubInternalText).join('；'));
                }
            });
        }

        return parts.join('\n').trim();
    }

    global.AIMasterAssistant = {
        escapeHtml: escapeHtml,
        encodeData: encodeData,
        scrubInternalText: scrubInternalText,
        inferPendingSteps: inferPendingSteps,
        inferPptCopilotSteps: inferPptCopilotSteps,
        renderTrace: renderTrace,
        renderAgentActions: renderAgentActions,
        renderAssistantPayload: renderAssistantPayload,
        assistantToHistoryText: assistantToHistoryText
    };
})(window);
