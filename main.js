"use strict";

// Obsidian本体が提供するAPI群を読み込む
// Plugin              … プラグイン本体の基底クラス
// PluginSettingTab    … プラグイン設定画面（歯車アイコンから開く画面）の基底クラス
// Setting             … 設定画面の1項目（トグル、スライダー等）を作るためのビルダー
// Notice              … 画面右下に一時的に表示する通知（トースト）
const { Plugin, PluginSettingTab, Setting, Notice } = require("obsidian");

// プラグインの初期設定値（初回起動時や未保存の項目に使われるデフォルト）
// decayFactor  … 1ホップ離れるごとに色の影響力を何倍に減衰させるか（0〜1）
// minInfluence … これを下回る影響力は無視する（ノイズ除去・計算打ち切り用の閾値）
// maxHops      … 色を持たないノードから何ホップ先まで探索するか
// autoApply    … グラフビュー表示時などに自動で色を反映するかどうか
const DEFAULT_SETTINGS = {
  decayFactor: 0.6,
  minInfluence: 0.05,
  maxHops: 3,
  autoApply: true,
};

class GraphColorPropagationPlugin extends Plugin {
  // Obsidianがプラグインを読み込むときに自動的に呼ばれる初期化処理
  async onload() {
    // 保存済みの設定（data.json）を読み込み、デフォルト値とマージする
    await this.loadSettings();

    // ============================================================
    // グラフ設定（.obsidian/graph.json）の「変更検知用」の状態変数
    // ------------------------------------------------------------
    // グラフビューの「グループ」パネルで色を変更すると、Obsidianは
    // その内容を .obsidian/graph.json に書き込む。しかしこの書き込みは
    // 通常のノート編集とは異なる特別な経路（vault.adapter を直接使う経路）で
    // 行われることが多く、vault.on("modify") イベントが発火しない
    // ケースが少なくない（＝隠し設定ファイルは通常のファイルイベント監視の
    // 対象外になりやすい）。
    //
    // そこで本プラグインでは、
    //   ①vault.on("modify") による検知（発火すればラッキー、な保険）
    //   ②workspace.on("layout-change") による検知（グラフビューが
    //     開かれた/切り替わったタイミングでの再適用）
    //   ③一定間隔でのポーリングによる内容比較（最も確実な方法）
    // の3段構えで「グループ設定の変更」を検知し、変更があれば
    // ボタン操作なしで即座に色を再計算・再適用する。
    //
    // lastGroupColorsJson には「前回チェック時点でのグループ設定」を
    // JSON文字列化して保持しておき、次回チェック時に内容が変わって
    // いないか（＝ユーザーが色を変更していないか）を比較する。
    this.lastGroupColorsJson = null;

    // プラグイン設定画面（歯車アイコン → コミュニティプラグイン → 本プラグイン）を登録
    this.addSettingTab(new GraphColorSettingTab(this.app, this));

    // コマンドパレット（Ctrl/Cmd+P）から手動で色を適用できるコマンドを登録
    this.addCommand({
      id: "apply-graph-colors",
      name: "Apply propagated colors to graph",
      callback: () => this.applyColors(),
    });

    // デバッグ用コマンド：グラフのノード内部構造をコンソールに出力する
    // （renderer側の内部実装がObsidianのバージョンによって変わることがあるため、
    //   問題調査時にノードオブジェクトの中身を確認できるようにしておく）
    this.addCommand({
      id: "debug-node-structure",
      name: "Debug: Dump node structure to console",
      callback: () => this.debugNodeStructure(),
    });

    // 左サイドバーのリボンに「パレット」アイコンを追加し、クリックで手動適用できるようにする
    this.addRibbonIcon("palette", "Apply graph color propagation", () => {
      this.applyColors();
    });

    // ------------------------------------------------------------
    // ①グラフビューが開かれた／レイアウトが切り替わったタイミングで自動適用
    // ------------------------------------------------------------
    // これは「グループ設定が変わったこと」を検知するものではなく、
    // 「グラフビューが新しく表示された（＝まだ色が反映されていない可能性が高い）」
    // タイミングを捉えるためのもの。
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        if (this.settings.autoApply) {
          const graphLeaves = this.app.workspace.getLeavesOfType("graph");
          if (graphLeaves.length > 0) {
            // グラフの描画（Pixi.jsによるレンダラー初期化）が完了するまで
            // 少し待ってから適用する。即座に実行するとrendererやnodeLookupが
            // まだ準備できておらず処理が失敗することがあるため。
            setTimeout(() => this.applyColors(), 1000);
          }
        }
      }),
    );

    // ------------------------------------------------------------
    // ②グラフ設定ファイル（.obsidian/graph.json）の変更をvaultイベントで監視
    // ------------------------------------------------------------
    // 前述の通り、この方式は環境によっては発火しないことがあるため
    // 「保険」として残しつつ、確実な検知は下記③のポーリングに任せる。
    // 発火した場合はcheckGraphConfigChanged()経由で処理することで、
    // ③のポーリングと状態（lastGroupColorsJson）を一元管理する。
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file.path === ".obsidian/graph.json") {
          setTimeout(() => this.checkGraphConfigChanged(), 200);
        }
      }),
    );

    // ------------------------------------------------------------
    // ③グラフ設定の内容を一定間隔でポーリングし、変化があれば即座に反映（最重要）
    // ------------------------------------------------------------
    // 「今すぐ適用」ボタンを押さなくても、グラフビューの「グループ」パネルで
    // 色を変更した数百ミリ秒後には自動的にグラフへ反映されるようにするための
    // 中核となる仕組み。500msごとにgraph.jsonの内容（＝グループ設定）を読み込み、
    // 前回読み込んだ内容と比較する。差分があれば即座にapplyColors()を実行する。
    //
    // registerInterval()を使うことで、プラグインが無効化・アンロードされた際に
    // Obsidianが自動的にこのintervalをクリアしてくれる（メモリリーク防止）。
    this.registerInterval(
      window.setInterval(() => this.checkGraphConfigChanged(), 500),
    );

    // アプリ起動直後・プラグイン有効化直後にも一度チェックしておく
    // （初回はlastGroupColorsJsonがnullなので、比較は行わず現在値を記録するだけ）
    this.checkGraphConfigChanged();
  }

  // プラグインが無効化・アンインストールされる際に呼ばれる後始末処理
  onunload() {
    // プラグインが renderCallback を上書き（フック）していた場合、
    // 元の描画処理に戻してからプラグイン独自のデータを削除する。
    // これを怠ると、プラグイン無効化後もグラフの色上書き処理が
    // 残り続けてしまう（他プラグインとの競合やメモリリークの原因になる）。
    const graphLeaves = this.app.workspace.getLeavesOfType("graph");
    for (const leaf of graphLeaves) {
      const renderer = leaf.view?.renderer;
      if (!renderer) continue;
      if (renderer._originalRenderCallback) {
        // 保存しておいた「本来のrenderCallback」を復元
        renderer.renderCallback = renderer._originalRenderCallback;
        // プラグイン用に生やしたプロパティを掃除
        delete renderer._originalRenderCallback;
        delete renderer._propagatedColors;
      }
    }
  }

  // data.json（Obsidianがプラグインごとに用意する保存領域）から設定を読み込む
  // 保存されている値が無い項目は DEFAULT_SETTINGS の値で補完する
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  // 現在の設定内容を data.json に保存する
  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ==================================================================
  // グラフ設定（グループの色分け情報）の変更検知
  // ==================================================================
  // 現在のグループ設定を取得し、前回チェック時と内容が異なっていれば
  // 「ユーザーがグラフビューのグループ色を変更した」とみなして
  // applyColors()を自動実行する。ボタン操作を挟まずに即時反映するための要。
  async checkGraphConfigChanged() {
    // 現時点でのグループ設定（クエリと色のペアの配列）を取得
    const groups = await this.getGraphGroups();
    // 比較しやすいように文字列化（配列の中身・順序も含めて完全一致比較する）
    const json = JSON.stringify(groups);

    // 初回実行時は比較対象がまだ無いので、現在の内容を記録するだけで終了する
    // （プラグイン起動直後にいきなり色を適用してしまうのを防ぐ）
    if (this.lastGroupColorsJson === null) {
      this.lastGroupColorsJson = json;
      return;
    }

    // 前回チェック時から内容が変わっていなければ何もしない（無駄な再計算を避ける）
    if (json === this.lastGroupColorsJson) return;

    // 内容が変化していた＝グループ設定（色分け）が更新された、と判断
    this.lastGroupColorsJson = json;

    // グラフビューが実際に開かれていない場合、applyColors内で
    // 「グラフビューが開いていません」という通知が出てしまい煩わしいため、
    // 開かれているときだけ静かに自動適用する。
    const graphLeaves = this.app.workspace.getLeavesOfType("graph");
    if (graphLeaves.length > 0) {
      await this.applyColors();
    }
  }

  // ==================================================================
  // グラフビューの「グループ」設定（.obsidian/graph.json）を読み込む
  // ==================================================================
  // 戻り値: [{ query: "path:foo" または "tag:bar", color: "#rrggbb" }, ...]
  async getGraphGroups() {
    try {
      // vault.configDir で「.obsidian」フォルダの実際のパスを取得する
      // （ユーザーがconfigフォルダ名をカスタマイズしている場合にも対応するため、
      //   ハードコードで ".obsidian" と決め打ちしない）
      const configDir = this.app.vault.configDir;
      const graphPath = configDir + "/graph.json";


      let content = null;

      // 方法1: vault経由での読み込みを試みる
      // 設定ファイルはvaultのファイルツリーには現れないことが多いため、
      // getAbstractFileByPathがnullを返すことも多い（その場合は方法2へ）
      const graphConfigFile = this.app.vault.getAbstractFileByPath(graphPath);
      if (graphConfigFile) {
        content = await this.app.vault.read(graphConfigFile);
      }

      // 方法2: adapter経由で読み込む
      // adapterはvaultのファイルツリーの外（隠しフォルダ等）にも直接アクセスできるため、
      // 設定ファイルの読み込みにはこちらが本命となることが多い
      if (!content) {
        try {
          content = await this.app.vault.adapter.read(graphPath);
        } catch (e2) {
          // ファイルがまだ存在しない（一度もグラフのグループ設定をしていない）場合等
          console.debug("adapter.read failed:", e2);
        }
      }

      // どちらの方法でも読み込めなかった場合は空配列を返す
      if (!content) {

        return [];
      }

      // JSON文字列をパースしてオブジェクトに変換
      const config = JSON.parse(content);


      // colorGroups が無い場合は空配列扱いにする（オプショナルチェイニング＋??）
      const groups = config?.colorGroups ?? [];


      // query（フィルタ条件文字列）と color（色情報）の両方が
      // 設定されているグループだけを対象にし、扱いやすい形式に整形する
      return groups
        .filter((g) => g.query && g.color)
        .map((g) => {
          // Obsidianの色設定は { rgb: 数値 } の形式のことも、
          // 直接カラーコード（文字列）のこともあるため両対応する
          const rgb = g.color.rgb ?? g.color;
          const hex =
            "#" +
            (typeof rgb === "number"
              ? // 数値（例: 0xff0000）の場合は16進数文字列に変換し、
                // 6桁になるようゼロ埋めする
                rgb.toString(16).padStart(6, "0")
              : // 文字列の場合は先頭の "#" を取り除いておく
                rgb.replace("#", ""));
          return { query: g.query.trim(), color: hex };
        });
    } catch (e) {
      // 予期しないエラー（JSON壊れ等）はコンソールに出すだけにして、
      // プラグイン全体がクラッシュしないようにする
      console.error("graph.json の読み込みに失敗:", e);
      return [];
    }
  }

  // "#rrggbb" 形式の16進カラーコードを {r, g, b}（0〜255の数値）に変換する
  // 形式が不正な場合は null を返す
  hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? {
          r: parseInt(result[1], 16),
          g: parseInt(result[2], 16),
          b: parseInt(result[3], 16),
        }
      : null;
  }

  // {r, g, b}（数値）を "#rrggbb" 形式の16進カラーコードに変換する
  // 計算結果が0〜255の範囲を超えないようクランプしてから丸める
  rgbToHex(r, g, b) {
    return (
      "#" +
      [r, g, b]
        .map((v) =>
          Math.round(Math.min(255, Math.max(0, v)))
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")
    );
  }

  // 指定したノート（path）が、どのグループ（色）に属するかを判定する
  // グループ設定は配列の先頭から順にチェックし、最初にマッチしたものを採用する
  // （Obsidianのグラフビュー本体の挙動に合わせている）
  getNodeGroup(path, groupColors) {
    for (const group of groupColors) {
      if (!group.query || !group.color) continue;
      const query = group.query.trim();

      if (query.startsWith("path:")) {
        // "path:フォルダ名" 形式 → パスの前方一致で判定
        const prefix = query.slice(5).trim();
        if (path.startsWith(prefix)) return group.color;
      } else if (query.startsWith("tag:")) {
        // "tag:タグ名" 形式 → そのノートのタグ（本文中のタグ／フロントマターのタグ）を確認
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file) {
          const cache = this.app.metadataCache.getFileCache(file);
          const tag = query.slice(4).trim().replace(/^#/, "");

          // 本文中に書かれたタグ（#tag形式）をチェック
          if (cache?.tags?.some((t) => t.tag.replace(/^#/, "") === tag))
            return group.color;

          // フロントマター（YAML）のtagsプロパティもチェック
          // 値が単一文字列の場合・配列の場合の両方に対応する
          if (cache?.frontmatter?.tags) {
            const tags = Array.isArray(cache.frontmatter.tags)
              ? cache.frontmatter.tags
              : [cache.frontmatter.tags];
            if (tags.some((t) => t === tag)) return group.color;
          }
        }
      }
      // "path:" "tag:" 以外のクエリ形式（例: 検索演算子を組み合わせた複雑な条件）は
      // 現状未対応。該当なしとして次のグループの判定に進む。
    }
    // どのグループにも該当しなかった場合は null（＝色なし＝伝播の対象）
    return null;
  }

  // 開発・デバッグ用：現在開いているグラフビューの最初のノードの
  // 内部データ構造をコンソールに出力する。
  // Obsidianのバージョンアップでrenderer内部の構造（circle/color/fill/tint等の
  // どのプロパティに色情報が入っているか）が変わることがあるため、
  // 動作不良時の調査に使う。
  debugNodeStructure() {
    const graphLeaves = this.app.workspace.getLeavesOfType("graph");
    if (graphLeaves.length === 0) {
      new Notice("No graph view is open.");
      return;
    }
    const renderer = graphLeaves[0].view?.renderer;
    if (!renderer) {
      new Notice("Graph renderer not found.");
      return;
    }
    const firstKey = Object.keys(renderer.nodeLookup)[0];
    const firstNode = renderer.nodeLookup[firstKey];
    console.log("=== Node Debug ===");
    console.log("key:", firstKey);
    console.log("node keys:", Object.keys(firstNode || {}));
    console.log("node:", firstNode);
    new Notice("Node structure dumped to developer console.");
  }

  // ==================================================================
  // メイン処理：グループの色をもとに、色を持たないノートへ色を伝播させ
  // グラフビューへ実際に反映する
  // ==================================================================
  async applyColors() {
    // ---- 手順1: グラフビューのグループ設定（色分けルール）を取得 ----
    const groupColors = await this.getGraphGroups();

    if (groupColors.length === 0) {
      new Notice(
        "No color groups found. Define groups in Graph view settings first.",
      );
      return;
    }

    // ---- 手順2: Vault内の全Markdownファイルを取得 ----
    const files = this.app.vault.getMarkdownFiles();
    if (files.length === 0) {
      new Notice("No notes found in the vault.");
      return;
    }

    // ---- 手順3: ノードマップを構築 ----
    // 各ノート（ファイル）ごとに
    //   color: グループ設定に基づく「元々の色」（無ければnull＝伝播対象）
    //   links: リンクで直接つながっている他ノートのパス集合（無向グラフとして扱う）
    // を持つエントリを作成する
    const nodeMap = new Map();
    for (const file of files) {
      const color = this.getNodeGroup(file.path, groupColors);
      nodeMap.set(file.path, { color, links: new Set() });
    }

    // ---- 手順4: リンク関係（グラフのエッジ）を構築 ----
    // metadataCacheから各ノートの本文中のリンク（[[wikilink]]等）を取得し、
    // リンク先の実ファイルを解決してnodeMapの双方向リンクとして登録する
    // （Obsidianのグラフビューはリンクの向きに関わらず線で結ぶため、無向グラフとして扱う）
    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache?.links) continue;
      for (const link of cache.links) {
        const target = this.app.metadataCache.getFirstLinkpathDest(
          link.link,
          file.path,
        );
        if (target && nodeMap.has(target.path)) {
          nodeMap.get(file.path).links.add(target.path);
          nodeMap.get(target.path).links.add(file.path);
        }
      }
    }

    // ---- 手順5: 色伝播計算（幅優先探索・BFS） ----
    // 色を持たない各ノートについて、そのノートを起点にBFSで隣接ノートを辿り、
    // 「色を持つノード」に到達するたびに
    //   影響力 weight = decayFactor ^ (ホップ数)
    // として記録する。ホップ数が離れるほど影響力が指数的に小さくなる仕組み。
    // 最終的に、複数の色源から受け取った影響力を重みとした加重平均で
    // 最終的な色（RGB）を決定する。
    const propagated = new Map();
    for (const [path, node] of nodeMap) {
      // 既に色が設定されているノードは伝播計算の対象外（そのままの色を使う）
      if (node.color) continue;

      // BFS用の初期化
      const visited = new Set([path]); // 探索済みノードの集合（重複探索防止）
      const queue = [{ p: path, hop: 0 }]; // 探索キュー（ノードパスと現在のホップ数）
      const influences = []; // 収集した色源とその重みのリスト

      while (queue.length > 0) {
        const { p, hop } = queue.shift();

        // 設定された最大ホップ数を超えたら、これ以上その経路は探索しない
        if (hop >= this.settings.maxHops) continue;

        // 現在のノードに直接つながっている隣接ノードを1つずつ確認
        for (const neighbor of nodeMap.get(p)?.links ?? []) {
          if (visited.has(neighbor)) continue;
          visited.add(neighbor);
          const neighborNode = nodeMap.get(neighbor);
          if (!neighborNode) continue;

          if (neighborNode.color) {
            // 隣接ノードが色を持っている＝色源を発見
            const rgb = this.hexToRgb(neighborNode.color);
            if (rgb) {
              // ホップ数+1（今回進んだ分）に応じて影響力を減衰させる
              const weight = Math.pow(this.settings.decayFactor, hop + 1);
              // 影響力が閾値未満なら無視する（計算コスト削減・ノイズ除去）
              if (weight >= this.settings.minInfluence) {
                influences.push({ ...rgb, weight });
              }
            }
            // 色を持つノードはそこで探索を打ち切る（その先へは伝播させない仕様）
          } else {
            // 色を持っていない中継ノード → さらに1ホップ先を探索するためキューに追加
            queue.push({ p: neighbor, hop: hop + 1 });
          }
        }
      }

      // 到達できる色源が1つも無かった場合は、色を決定できないのでスキップ
      if (influences.length === 0) continue;

      // 重み付き平均でR/G/Bそれぞれの最終的な色を算出する
      const totalWeight = influences.reduce((s, i) => s + i.weight, 0);
      const r =
        influences.reduce((s, i) => s + i.r * i.weight, 0) / totalWeight;
      const g =
        influences.reduce((s, i) => s + i.g * i.weight, 0) / totalWeight;
      const b =
        influences.reduce((s, i) => s + i.b * i.weight, 0) / totalWeight;
      propagated.set(path, { r, g, b });
    }

    if (propagated.size === 0) {
      new Notice("No nodes to propagate colors to.");
      return;
    }

    // ---- 手順6: 実際のグラフビュー（複数開いている場合は全て）に色を適用 ----
    const graphLeaves = this.app.workspace.getLeavesOfType("graph");
    if (graphLeaves.length === 0) {
      new Notice("No graph view is open.");
      return;
    }

    let applied = 0;
    for (const leaf of graphLeaves) {
      const renderer = leaf.view?.renderer;
      if (!renderer?.nodeLookup) continue;

      // 計算した伝播色をrendererに保存しておく
      // （renderCallback内から参照するため、rendererのプロパティとして持たせる）
      renderer._propagatedColors = propagated;

      // ------------------------------------------------------------
      // renderCallbackのラップ（フック）
      // ------------------------------------------------------------
      // Obsidianのグラフは毎フレーム renderCallback を呼び出して描画しており、
      // 何もしなければ次のフレームで色が標準の描画色に戻されてしまう。
      // そこで「本来のrenderCallback」を実行した直後に、伝播色で上書きする
      // 処理を追加した、新しいrenderCallbackに差し替える。
      // 既に差し替え済み（他のapplyColors実行時）の場合は再度差し替えない
      // （_originalRenderCallbackが二重に保存されるのを防ぐため）。
      if (!renderer._originalRenderCallback) {
        renderer._originalRenderCallback = renderer.renderCallback;
        renderer.renderCallback = () => {
          // まず元々の描画処理（Obsidian標準のノード描画等）を実行
          if (renderer._originalRenderCallback) {
            renderer._originalRenderCallback();
          }
          // その後、伝播色が設定されているノードだけ色を上書きする
          if (renderer._propagatedColors && renderer.nodeLookup) {
            for (const [nodePath, nodeData] of Object.entries(
              renderer.nodeLookup,
            )) {
              if (!renderer._propagatedColors.has(nodePath)) continue;
              const { r, g, b } = renderer._propagatedColors.get(nodePath);
              // RGB各値（0〜255）を1つの24bit整数（0xRRGGBB形式）に変換
              const colorInt =
                (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
              // Obsidianのバージョンによってノードの色を持つプロパティ名が
              // 異なる（circle.tint / color / fill / tint）ため、
              // 存在するプロパティを順に探して設定する
              if (nodeData?.circle) nodeData.circle.tint = colorInt;
              else if (nodeData?.color !== undefined) nodeData.color = colorInt;
              else if (nodeData?.fill !== undefined) nodeData.fill = colorInt;
              else if (nodeData?.tint !== undefined) nodeData.tint = colorInt;
            }
          }
        };
      } else {
        // 既にフック済みの場合は、参照している伝播色データだけを最新に更新する
        // （renderCallback自体は使い回すため、二重フックを避けられる）
        renderer._propagatedColors = propagated;
      }

      // ------------------------------------------------------------
      // 初回適用（即時反映）
      // ------------------------------------------------------------
      // renderCallbackのフックは「次に描画が走ったとき」に効果を発揮するが、
      // ここでは念のため今のnodeLookupに対しても直接色を設定しておき、
      // さらに直後にrenderCallback()を明示的に呼んで即座に画面へ反映させる。
      for (const [nodePath, nodeData] of Object.entries(renderer.nodeLookup)) {
        if (!propagated.has(nodePath)) continue;
        const { r, g, b } = propagated.get(nodePath);
        const colorInt =
          (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
        let colorSet = false;
        if (nodeData?.circle) {
          nodeData.circle.tint = colorInt;
          colorSet = true;
        } else if (nodeData?.color !== undefined) {
          nodeData.color = colorInt;
          colorSet = true;
        } else if (nodeData?.fill !== undefined) {
          nodeData.fill = colorInt;
          colorSet = true;
        } else if (nodeData?.tint !== undefined) {
          nodeData.tint = colorInt;
          colorSet = true;
        }
        if (colorSet) applied++;
      }

      // 上記で設定した色を画面に反映させるため、描画を1回明示的に走らせる
      renderer.renderCallback();
    }

    new Notice(
      `Applied colors to ${applied} node(s) (synced ${groupColors.length} group(s)).`,
    );
  }
}

// ======================================================================
// プラグイン設定画面（Obsidianの「設定」→「コミュニティプラグイン」から開く画面）
// ======================================================================
class GraphColorSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // 設定画面が表示される際に呼ばれ、画面の中身（DOM）を組み立てる
  display() {
    const { containerEl } = this;
    // 再描画のたびに前回の内容をクリアしておく
    containerEl.empty();

    containerEl.createEl("h2", { text: "Graph Color Propagation" });

    containerEl.createEl("p", {
      text: "Color groups are automatically synced from Graph view settings. Define your groups there.",
      cls: "setting-item-description",
    });

    // --- 自動適用のON/OFFトグル ---
    // ONの場合、グラフビューを開いたとき・グループ設定を変更したときに
    // ボタン操作なしで自動的に色が反映される（本プラグインの中心機能）
    new Setting(containerEl)
      .setName("Auto-apply on graph open")
      .setDesc(
        "Automatically propagate colors when the graph view opens or group settings change.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoApply)
          .onChange(async (value) => {
            this.plugin.settings.autoApply = value;
            await this.plugin.saveSettings();
          }),
      );

    // --- 減衰係数（decayFactor）のスライダー ---
    // 1ホップ進むごとに色の影響力へ掛け算される係数。
    // 1.0に近いほど遠くのノードの色も強く影響し、0に近いほどすぐ影響が消える。
    new Setting(containerEl)
      .setName("Decay factor")
      .setDesc(
        "Multiplier applied per hop (0–1). Lower values make distant colors fade faster.",
      )
      .addSlider((slider) =>
        slider
          .setLimits(0.1, 1.0, 0.05)
          .setValue(this.plugin.settings.decayFactor)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.decayFactor = value;
            await this.plugin.saveSettings();
          }),
      );

    // --- 最大ホップ数（maxHops）のスライダー ---
    // 色を持たないノードから、色源を探すために何ホップ先まで
    // BFSで探索するかの上限。値が大きいほど計算量が増える。
    new Setting(containerEl)
      .setName("Max hops")
      .setDesc("How many hops to search for colored nodes (1–5).")
      .addSlider((slider) =>
        slider
          .setLimits(1, 5, 1)
          .setValue(this.plugin.settings.maxHops)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxHops = value;
            await this.plugin.saveSettings();
          }),
      );

    // --- 最小影響度（minInfluence）のスライダー ---
    // この値未満に減衰した色源は「ほぼ無視できるレベル」とみなし、
    // 計算対象から除外する（無駄な遠距離の色源計算を打ち切るための閾値）
    new Setting(containerEl)
      .setName("Min influence")
      .setDesc("Colors with weight below this threshold are ignored (0.01–0.2).")
      .addSlider((slider) =>
        slider
          .setLimits(0.01, 0.2, 0.01)
          .setValue(this.plugin.settings.minInfluence)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.minInfluence = value;
            await this.plugin.saveSettings();
          }),
      );

    // --- 手動適用ボタン ---
    // 自動適用がOFFの場合や、即座に強制的に再計算したい場合に使う
    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText("Apply now")
        .setCta()
        .onClick(() => this.plugin.applyColors()),
    );
  }
}

module.exports = GraphColorPropagationPlugin;
