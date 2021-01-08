
// Released under MIT license
// Copyright (c) 2009-2010 Dominic Baggott
// Copyright (c) 2009-2010 Ash Berlin
// Copyright (c) 2011 Christoph Dorn <christoph@christophdorn.com> (http://www.christophdorn.com)
// Date: 2013-09-15T16:12Z

(function(expose) {




    var MarkdownHelpers = {};
  
    // For Spidermonkey based engines
    function mk_block_toSource() {
      return "Markdown.mk_block( " +
              uneval(this.toString()) +
              ", " +
              uneval(this.trailing) +
              ", " +
              uneval(this.lineNumber) +
              " )";
    }
  
    // node
    function mk_block_inspect() {
      var util = require("util");
      return "Markdown.mk_block( " +
              util.inspect(this.toString()) +
              ", " +
              util.inspect(this.trailing) +
              ", " +
              util.inspect(this.lineNumber) +
              " )";
  
    }
  
    MarkdownHelpers.mk_block = function(block, trail, line) {
      // Be helpful for default case in tests.
      if ( arguments.length === 1 )
        trail = "\n\n";
  
      // We actually need a String object, not a string primitive
      /* jshint -W053 */
      var s = new String(block);
      s.trailing = trail;
      // To make it clear its not just a string
      s.inspect = mk_block_inspect;
      s.toSource = mk_block_toSource;
  
      if ( line !== undefined )
        s.lineNumber = line;
  
      return s;
    };
  
  
    var isArray = MarkdownHelpers.isArray = Array.isArray || function(obj) {
      return Object.prototype.toString.call(obj) === "[object Array]";
    };
  
    // Don't mess with Array.prototype. Its not friendly
    if ( Array.prototype.forEach ) {
      MarkdownHelpers.forEach = function forEach( arr, cb, thisp ) {
        return arr.forEach( cb, thisp );
      };
    }
    else {
      MarkdownHelpers.forEach = function forEach(arr, cb, thisp) {
        for (var i = 0; i < arr.length; i++)
          cb.call(thisp || arr, arr[i], i, arr);
      };
    }
  
    MarkdownHelpers.isEmpty = function isEmpty( obj ) {
      for ( var key in obj ) {
        if ( hasOwnProperty.call( obj, key ) )
          return false;
      }
      return true;
    };
  
    MarkdownHelpers.extract_attr = function extract_attr( jsonml ) {
      return isArray(jsonml)
          && jsonml.length > 1
          && typeof jsonml[ 1 ] === "object"
          && !( isArray(jsonml[ 1 ]) )
          ? jsonml[ 1 ]
          : undefined;
    };
  
  
  
  
   /**
     *  class Markdown
     *
     *  Markdown processing in Javascript done right. We have very particular views
     *  on what constitutes 'right' which include:
     *
     *  - produces well-formed HTML (this means that em and strong nesting is
     *    important)
     *
     *  - has an intermediate representation to allow processing of parsed data (We
     *    in fact have two, both as [JsonML]: a markdown tree and an HTML tree).
     *
     *  - is easily extensible to add new dialects without having to rewrite the
     *    entire parsing mechanics
     *
     *  - has a good test suite
     *
     *  This implementation fulfills all of these (except that the test suite could
     *  do with expanding to automatically run all the fixtures from other Markdown
     *  implementations.)
     *
     *  ##### Intermediate Representation
     *
     *  *TODO* Talk about this :) Its JsonML, but document the node names we use.
     *
     *  [JsonML]: http://jsonml.org/ "JSON Markup Language"
     **/
    var Markdown = function(dialect) {
      switch (typeof dialect) {
      case "undefined":
        this.dialect = Markdown.dialects.Gruber;
        break;
      case "object":
        this.dialect = dialect;
        break;
      default:
        if ( dialect in Markdown.dialects )
          this.dialect = Markdown.dialects[dialect];
        else
          throw new Error("Unknown Markdown dialect '" + String(dialect) + "'");
        break;
      }
      this.em_state = [];
      this.strong_state = [];
      this.debug_indent = "";
    };
  
    /**
     * Markdown.dialects
     *
     * Namespace of built-in dialects.
     **/
    Markdown.dialects = {};
  
  
  
  
    // Imported functions
    var mk_block = Markdown.mk_block = MarkdownHelpers.mk_block,
        isArray = MarkdownHelpers.isArray;
  
    /**
     *  parse( markdown, [dialect] ) -> JsonML
     *  - markdown (String): markdown string to parse
     *  - dialect (String | Dialect): the dialect to use, defaults to gruber
     *
     *  Parse `markdown` and return a markdown document as a Markdown.JsonML tree.
     **/
    Markdown.parse = function( source, dialect ) {
      // dialect will default if undefined
      var md = new Markdown( dialect );
      return md.toTree( source );
    };
  
    function count_lines( str ) {
      var n = 0,
          i = -1;
      while ( ( i = str.indexOf("\n", i + 1) ) !== -1 )
        n++;
      return n;
    }
  
    // Internal - split source into rough blocks
    Markdown.prototype.split_blocks = function splitBlocks( input ) {
      input = input.replace(/(\r\n|\n|\r)/g, "\n");
      // [\s\S] matches _anything_ (newline or space)
      // [^] is equivalent but doesn't work in IEs.
      var re = /([\s\S]+?)($|\n#|\n(?:\s*\n|$)+)/g,
          blocks = [],
          m;
  
      var line_no = 1;
  
      if ( ( m = /^(\s*\n)/.exec(input) ) !== null ) {
        // skip (but count) leading blank lines
        line_no += count_lines( m[0] );
        re.lastIndex = m[0].length;
      }
  
      while ( ( m = re.exec(input) ) !== null ) {
        if (m[2] === "\n#") {
          m[2] = "\n";
          re.lastIndex--;
        }
        blocks.push( mk_block( m[1], m[2], line_no ) );
        line_no += count_lines( m[0] );
      }
  
      return blocks;
    };
  
    /**
     *  Markdown#processBlock( block, next ) -> undefined | [ JsonML, ... ]
     *  - block (String): the block to process
     *  - next (Array): the following blocks
     *
     * Process `block` and return an array of JsonML nodes representing `block`.
     *
     * It does this by asking each block level function in the dialect to process
     * the block until one can. Succesful handling is indicated by returning an
     * array (with zero or more JsonML nodes), failure by a false value.
     *
     * Blocks handlers are responsible for calling [[Markdown#processInline]]
     * themselves as appropriate.
     *
     * If the blocks were split incorrectly or adjacent blocks need collapsing you
     * can adjust `next` in place using shift/splice etc.
     *
     * If any of this default behaviour is not right for the dialect, you can
     * define a `__call__` method on the dialect that will get invoked to handle
     * the block processing.
     */
    Markdown.prototype.processBlock = function processBlock( block, next ) {
      var cbs = this.dialect.block,
          ord = cbs.__order__;
  
      if ( "__call__" in cbs )
        return cbs.__call__.call(this, block, next);
  
      for ( var i = 0; i < ord.length; i++ ) {
        //D:this.debug( "Testing", ord[i] );
        var res = cbs[ ord[i] ].call( this, block, next );
        if ( res ) {
          //D:this.debug("  matched");
          if ( !isArray(res) || ( res.length > 0 && !( isArray(res[0]) ) ) )
            this.debug(ord[i], "didn't return a proper array");
          //D:this.debug( "" );
          return res;
        }
      }
  
      // Uhoh! no match! Should we throw an error?
      return [];
    };
  
    Markdown.prototype.processInline = function processInline( block ) {
      return this.dialect.inline.__call__.call( this, String( block ) );
    };
  
    /**
     *  Markdown#toTree( source ) -> JsonML
     *  - source (String): markdown source to parse
     *
     *  Parse `source` into a JsonML tree representing the markdown document.
     **/
    // custom_tree means set this.tree to `custom_tree` and restore old value on return
    Markdown.prototype.toTree = function toTree( source, custom_root ) {
      var blocks = source instanceof Array ? source : this.split_blocks( source );
  
      // Make tree a member variable so its easier to mess with in extensions
      var old_tree = this.tree;
      try {
        this.tree = custom_root || this.tree || [ "markdown" ];
  
        blocks_loop:
        while ( blocks.length ) {
          var b = this.processBlock( blocks.shift(), blocks );
  
          // Reference blocks and the like won't return any content
          if ( !b.length )
            continue blocks_loop;
  
          this.tree.push.apply( this.tree, b );
        }
        return this.tree;
      }
      finally {
        if ( custom_root )
          this.tree = old_tree;
      }
    };
  
    // Noop by default
    Markdown.prototype.debug = function () {
      var args = Array.prototype.slice.call( arguments);
      args.unshift(this.debug_indent);
      if ( typeof print !== "undefined" )
        print.apply( print, args );
      if ( typeof console !== "undefined" && typeof console.log !== "undefined" )
        console.log.apply( null, args );
    };
  
    Markdown.prototype.loop_re_over_block = function( re, block, cb ) {
      // Dont use /g regexps with this
      var m,
          b = block.valueOf();
  
      while ( b.length && (m = re.exec(b) ) !== null ) {
        b = b.substr( m[0].length );
        cb.call(this, m);
      }
      return b;
    };
  
    // Build default order from insertion order.
    Markdown.buildBlockOrder = function(d) {
      var ord = [];
      for ( var i in d ) {
        if ( i === "__order__" || i === "__call__" )
          continue;
        ord.push( i );
      }
      d.__order__ = ord;
    };
  
    // Build patterns for inline matcher
    Markdown.buildInlinePatterns = function(d) {
      var patterns = [];
  
      for ( var i in d ) {
        // __foo__ is reserved and not a pattern
        if ( i.match( /^__.*__$/) )
          continue;
        var l = i.replace( /([\\.*+?|()\[\]{}])/g, "\\$1" )
                 .replace( /\n/, "\\n" );
        patterns.push( i.length === 1 ? l : "(?:" + l + ")" );
      }
  
      patterns = patterns.join("|");
      d.__patterns__ = patterns;
      //print("patterns:", uneval( patterns ) );
  
      var fn = d.__call__;
      d.__call__ = function(text, pattern) {
        if ( pattern !== undefined )
          return fn.call(this, text, pattern);
        else
          return fn.call(this, text, patterns);
      };
    };
  
  
  
  
    var extract_attr = MarkdownHelpers.extract_attr;
  
    /**
     *  renderJsonML( jsonml[, options] ) -> String
     *  - jsonml (Array): JsonML array to render to XML
     *  - options (Object): options
     *
     *  Converts the given JsonML into well-formed XML.
     *
     *  The options currently understood are:
     *
     *  - root (Boolean): wether or not the root node should be included in the
     *    output, or just its children. The default `false` is to not include the
     *    root itself.
     */
    Markdown.renderJsonML = function( jsonml, options ) {
      options = options || {};
      // include the root element in the rendered output?
      options.root = options.root || false;
  
      var content = [];
  
      if ( options.root ) {
        content.push( render_tree( jsonml ) );
      }
      else {
        jsonml.shift(); // get rid of the tag
        if ( jsonml.length && typeof jsonml[ 0 ] === "object" && !( jsonml[ 0 ] instanceof Array ) )
          jsonml.shift(); // get rid of the attributes
  
        while ( jsonml.length )
          content.push( render_tree( jsonml.shift() ) );
      }
  
      return content.join( "\n\n" );
    };
  
  
    /**
     *  toHTMLTree( markdown, [dialect] ) -> JsonML
     *  toHTMLTree( md_tree ) -> JsonML
     *  - markdown (String): markdown string to parse
     *  - dialect (String | Dialect): the dialect to use, defaults to gruber
     *  - md_tree (Markdown.JsonML): parsed markdown tree
     *
     *  Turn markdown into HTML, represented as a JsonML tree. If a string is given
     *  to this function, it is first parsed into a markdown tree by calling
     *  [[parse]].
     **/
    Markdown.toHTMLTree = function toHTMLTree( input, dialect , options ) {
  
      // convert string input to an MD tree
      if ( typeof input === "string" )
        input = this.parse( input, dialect );
  
      // Now convert the MD tree to an HTML tree
  
      // remove references from the tree
      var attrs = extract_attr( input ),
          refs = {};
  
      if ( attrs && attrs.references )
        refs = attrs.references;
  
      var html = convert_tree_to_html( input, refs , options );
      merge_text_nodes( html );
      return html;
    };
  
    /**
     *  toHTML( markdown, [dialect]  ) -> String
     *  toHTML( md_tree ) -> String
     *  - markdown (String): markdown string to parse
     *  - md_tree (Markdown.JsonML): parsed markdown tree
     *
     *  Take markdown (either as a string or as a JsonML tree) and run it through
     *  [[toHTMLTree]] then turn it into a well-formated HTML fragment.
     **/
    Markdown.toHTML = function toHTML( source , dialect , options ) {
      var input = this.toHTMLTree( source , dialect , options );
  
      return this.renderJsonML( input );
    };
  
  
    function escapeHTML( text ) {
      return text.replace( /&/g, "&amp;" )
                 .replace( /</g, "&lt;" )
                 .replace( />/g, "&gt;" )
                 .replace( /"/g, "&quot;" )
                 .replace( /'/g, "&#39;" );
    }
  
    function render_tree( jsonml ) {
      // basic case
      if ( typeof jsonml === "string" )
        return escapeHTML( jsonml );
  
      var tag = jsonml.shift(),
          attributes = {},
          content = [];
  
      if ( jsonml.length && typeof jsonml[ 0 ] === "object" && !( jsonml[ 0 ] instanceof Array ) )
        attributes = jsonml.shift();
  
      while ( jsonml.length )
        content.push( render_tree( jsonml.shift() ) );
  
      var tag_attrs = "";
      for ( var a in attributes )
        tag_attrs += " " + a + '="' + escapeHTML( attributes[ a ] ) + '"';
  
      // be careful about adding whitespace here for inline elements
      if ( tag === "img" || tag === "br" || tag === "hr" )
        return "<"+ tag + tag_attrs + "/>";
      else
        return "<"+ tag + tag_attrs + ">" + content.join( "" ) + "</" + tag + ">";
    }
  
    function convert_tree_to_html( tree, references, options ) {
      var i;
      options = options || {};
  
      // shallow clone
      var jsonml = tree.slice( 0 );
  
      if ( typeof options.preprocessTreeNode === "function" )
        jsonml = options.preprocessTreeNode(jsonml, references);
  
      // Clone attributes if they exist
      var attrs = extract_attr( jsonml );
      if ( attrs ) {
        jsonml[ 1 ] = {};
        for ( i in attrs ) {
          jsonml[ 1 ][ i ] = attrs[ i ];
        }
        attrs = jsonml[ 1 ];
      }
  
      // basic case
      if ( typeof jsonml === "string" )
        return jsonml;
  
      // convert this node
      switch ( jsonml[ 0 ] ) {
      case "header":
        jsonml[ 0 ] = "h" + jsonml[ 1 ].level;
        delete jsonml[ 1 ].level;
        break;
      case "bulletlist":
        jsonml[ 0 ] = "ul";
        break;
      case "numberlist":
        jsonml[ 0 ] = "ol";
        break;
      case "listitem":
        jsonml[ 0 ] = "li";
        break;
      case "para":
        jsonml[ 0 ] = "p";
        break;
      case "markdown":
        jsonml[ 0 ] = "html";
        if ( attrs )
          delete attrs.references;
        break;
      case "code_block":
        jsonml[ 0 ] = "pre";
        i = attrs ? 2 : 1;
        var code = [ "code" ];
        code.push.apply( code, jsonml.splice( i, jsonml.length - i ) );
        jsonml[ i ] = code;
        break;
      case "inlinecode":
        jsonml[ 0 ] = "code";
        break;
      case "img":
        jsonml[ 1 ].src = jsonml[ 1 ].href;
        delete jsonml[ 1 ].href;
        break;
      case "linebreak":
        jsonml[ 0 ] = "br";
        break;
      case "link":
        jsonml[ 0 ] = "a";
        break;
      case "link_ref":
        jsonml[ 0 ] = "a";
  
        // grab this ref and clean up the attribute node
        var ref = references[ attrs.ref ];
  
        // if the reference exists, make the link
        if ( ref ) {
          delete attrs.ref;
  
          // add in the href and title, if present
          attrs.href = ref.href;
          if ( ref.title )
            attrs.title = ref.title;
  
          // get rid of the unneeded original text
          delete attrs.original;
        }
        // the reference doesn't exist, so revert to plain text
        else {
          return attrs.original;
        }
        break;
      case "img_ref":
        jsonml[ 0 ] = "img";
  
        // grab this ref and clean up the attribute node
        var ref = references[ attrs.ref ];
  
        // if the reference exists, make the link
        if ( ref ) {
          delete attrs.ref;
  
          // add in the href and title, if present
          attrs.src = ref.href;
          if ( ref.title )
            attrs.title = ref.title;
  
          // get rid of the unneeded original text
          delete attrs.original;
        }
        // the reference doesn't exist, so revert to plain text
        else {
          return attrs.original;
        }
        break;
      }
  
      // convert all the children
      i = 1;
  
      // deal with the attribute node, if it exists
      if ( attrs ) {
        // if there are keys, skip over it
        for ( var key in jsonml[ 1 ] ) {
          i = 2;
          break;
        }
        // if there aren't, remove it
        if ( i === 1 )
          jsonml.splice( i, 1 );
      }
  
      for ( ; i < jsonml.length; ++i ) {
        jsonml[ i ] = convert_tree_to_html( jsonml[ i ], references, options );
      }
  
      return jsonml;
    }
  
  
    // merges adjacent text nodes into a single node
    function merge_text_nodes( jsonml ) {
      // skip the tag name and attribute hash
      var i = extract_attr( jsonml ) ? 2 : 1;
  
      while ( i < jsonml.length ) {
        // if it's a string check the next item too
        if ( typeof jsonml[ i ] === "string" ) {
          if ( i + 1 < jsonml.length && typeof jsonml[ i + 1 ] === "string" ) {
            // merge the second string into the first and remove it
            jsonml[ i ] += jsonml.splice( i + 1, 1 )[ 0 ];
          }
          else {
            ++i;
          }
        }
        // if it's not a string recurse
        else {
          merge_text_nodes( jsonml[ i ] );
          ++i;
        }
      }
    };
  
  
  
    var DialectHelpers = {};
    DialectHelpers.inline_until_char = function( text, want ) {
      var consumed = 0,
          nodes = [];
  
      while ( true ) {
        if ( text.charAt( consumed ) === want ) {
          // Found the character we were looking for
          consumed++;
          return [ consumed, nodes ];
        }
  
        if ( consumed >= text.length ) {
          // No closing char found. Abort.
          return null;
        }
  
        var res = this.dialect.inline.__oneElement__.call(this, text.substr( consumed ) );
        consumed += res[ 0 ];
        // Add any returned nodes.
        nodes.push.apply( nodes, res.slice( 1 ) );
      }
    };
  
    // Helper function to make sub-classing a dialect easier
    DialectHelpers.subclassDialect = function( d ) {
      function Block() {}
      Block.prototype = d.block;
      function Inline() {}
      Inline.prototype = d.inline;
  
      return { block: new Block(), inline: new Inline() };
    };
  
  
  
  
    var forEach = MarkdownHelpers.forEach,
        extract_attr = MarkdownHelpers.extract_attr,
        mk_block = MarkdownHelpers.mk_block,
        isEmpty = MarkdownHelpers.isEmpty,
        inline_until_char = DialectHelpers.inline_until_char;
  
    /**
     * Gruber dialect
     *
     * The default dialect that follows the rules set out by John Gruber's
     * markdown.pl as closely as possible. Well actually we follow the behaviour of
     * that script which in some places is not exactly what the syntax web page
     * says.
     **/
    var Gruber = {
      block: {
        atxHeader: function atxHeader( block, next ) {
          var m = block.match( /^(#{1,6})\s*(.*?)\s*#*\s*(?:\n|$)/ );
  
          if ( !m )
            return undefined;
  
          var header = [ "header", { level: m[ 1 ].length } ];
          Array.prototype.push.apply(header, this.processInline(m[ 2 ]));
  
          if ( m[0].length < block.length )
            next.unshift( mk_block( block.substr( m[0].length ), block.trailing, block.lineNumber + 2 ) );
  
          return [ header ];
        },
  
        setextHeader: function setextHeader( block, next ) {
          var m = block.match( /^(.*)\n([-=])\2\2+(?:\n|$)/ );
  
          if ( !m )
            return undefined;
  
          var level = ( m[ 2 ] === "=" ) ? 1 : 2,
              header = [ "header", { level : level }, m[ 1 ] ];
  
          if ( m[0].length < block.length )
            next.unshift( mk_block( block.substr( m[0].length ), block.trailing, block.lineNumber + 2 ) );
  
          return [ header ];
        },
  
        code: function code( block, next ) {
          // |    Foo
          // |bar
          // should be a code block followed by a paragraph. Fun
          //
          // There might also be adjacent code block to merge.
  
          var ret = [],
              re = /^(?: {0,3}\t| {4})(.*)\n?/;
  
          // 4 spaces + content
          if ( !block.match( re ) )
            return undefined;
  
          block_search:
          do {
            // Now pull out the rest of the lines
            var b = this.loop_re_over_block(
                      re, block.valueOf(), function( m ) { ret.push( m[1] ); } );
  
            if ( b.length ) {
              // Case alluded to in first comment. push it back on as a new block
              next.unshift( mk_block(b, block.trailing) );
              break block_search;
            }
            else if ( next.length ) {
              // Check the next block - it might be code too
              if ( !next[0].match( re ) )
                break block_search;
  
              // Pull how how many blanks lines follow - minus two to account for .join
              ret.push ( block.trailing.replace(/[^\n]/g, "").substring(2) );
  
              block = next.shift();
            }
            else {
              break block_search;
            }
          } while ( true );
  
          return [ [ "code_block", ret.join("\n") ] ];
        },
  
        horizRule: function horizRule( block, next ) {
          // this needs to find any hr in the block to handle abutting blocks
          var m = block.match( /^(?:([\s\S]*?)\n)?[ \t]*([-_*])(?:[ \t]*\2){2,}[ \t]*(?:\n([\s\S]*))?$/ );
  
          if ( !m )
            return undefined;
  
          var jsonml = [ [ "hr" ] ];
  
          // if there's a leading abutting block, process it
          if ( m[ 1 ] ) {
            var contained = mk_block( m[ 1 ], "", block.lineNumber );
            jsonml.unshift.apply( jsonml, this.toTree( contained, [] ) );
          }
  
          // if there's a trailing abutting block, stick it into next
          if ( m[ 3 ] )
            next.unshift( mk_block( m[ 3 ], block.trailing, block.lineNumber + 1 ) );
  
          return jsonml;
        },
  
        // There are two types of lists. Tight and loose. Tight lists have no whitespace
        // between the items (and result in text just in the <li>) and loose lists,
        // which have an empty line between list items, resulting in (one or more)
        // paragraphs inside the <li>.
        //
        // There are all sorts weird edge cases about the original markdown.pl's
        // handling of lists:
        //
        // * Nested lists are supposed to be indented by four chars per level. But
        //   if they aren't, you can get a nested list by indenting by less than
        //   four so long as the indent doesn't match an indent of an existing list
        //   item in the 'nest stack'.
        //
        // * The type of the list (bullet or number) is controlled just by the
        //    first item at the indent. Subsequent changes are ignored unless they
        //    are for nested lists
        //
        lists: (function( ) {
          // Use a closure to hide a few variables.
          var any_list = "[*+-]|\\d+\\.",
              bullet_list = /[*+-]/,
              // Capture leading indent as it matters for determining nested lists.
              is_list_re = new RegExp( "^( {0,3})(" + any_list + ")[ \t]+" ),
              indent_re = "(?: {0,3}\\t| {4})";
  
          // TODO: Cache this regexp for certain depths.
          // Create a regexp suitable for matching an li for a given stack depth
          function regex_for_depth( depth ) {
  
            return new RegExp(
              // m[1] = indent, m[2] = list_type
              "(?:^(" + indent_re + "{0," + depth + "} {0,3})(" + any_list + ")\\s+)|" +
              // m[3] = cont
              "(^" + indent_re + "{0," + (depth-1) + "}[ ]{0,4})"
            );
          }
          function expand_tab( input ) {
            return input.replace( / {0,3}\t/g, "    " );
          }
  
          // Add inline content `inline` to `li`. inline comes from processInline
          // so is an array of content
          function add(li, loose, inline, nl) {
            if ( loose ) {
              li.push( [ "para" ].concat(inline) );
              return;
            }
            // Hmmm, should this be any block level element or just paras?
            var add_to = li[li.length -1] instanceof Array && li[li.length - 1][0] === "para"
                       ? li[li.length -1]
                       : li;
  
            // If there is already some content in this list, add the new line in
            if ( nl && li.length > 1 )
              inline.unshift(nl);
  
            for ( var i = 0; i < inline.length; i++ ) {
              var what = inline[i],
                  is_str = typeof what === "string";
              if ( is_str && add_to.length > 1 && typeof add_to[add_to.length-1] === "string" )
                add_to[ add_to.length-1 ] += what;
              else
                add_to.push( what );
            }
          }
  
          // contained means have an indent greater than the current one. On
          // *every* line in the block
          function get_contained_blocks( depth, blocks ) {
  
            var re = new RegExp( "^(" + indent_re + "{" + depth + "}.*?\\n?)*$" ),
                replace = new RegExp("^" + indent_re + "{" + depth + "}", "gm"),
                ret = [];
  
            while ( blocks.length > 0 ) {
              if ( re.exec( blocks[0] ) ) {
                var b = blocks.shift(),
                    // Now remove that indent
                    x = b.replace( replace, "");
  
                ret.push( mk_block( x, b.trailing, b.lineNumber ) );
              }
              else
                break;
            }
            return ret;
          }
  
          // passed to stack.forEach to turn list items up the stack into paras
          function paragraphify(s, i, stack) {
            var list = s.list;
            var last_li = list[list.length-1];
  
            if ( last_li[1] instanceof Array && last_li[1][0] === "para" )
              return;
            if ( i + 1 === stack.length ) {
              // Last stack frame
              // Keep the same array, but replace the contents
              last_li.push( ["para"].concat( last_li.splice(1, last_li.length - 1) ) );
            }
            else {
              var sublist = last_li.pop();
              last_li.push( ["para"].concat( last_li.splice(1, last_li.length - 1) ), sublist );
            }
          }
  
          // The matcher function
          return function( block, next ) {
            var m = block.match( is_list_re );
            if ( !m )
              return undefined;
  
            function make_list( m ) {
              var list = bullet_list.exec( m[2] )
                       ? ["bulletlist"]
                       : ["numberlist"];
  
              stack.push( { list: list, indent: m[1] } );
              return list;
            }
  
  
            var stack = [], // Stack of lists for nesting.
                list = make_list( m ),
                last_li,
                loose = false,
                ret = [ stack[0].list ],
                i;
  
            // Loop to search over block looking for inner block elements and loose lists
            loose_search:
            while ( true ) {
              // Split into lines preserving new lines at end of line
              var lines = block.split( /(?=\n)/ );
  
              // We have to grab all lines for a li and call processInline on them
              // once as there are some inline things that can span lines.
              var li_accumulate = "", nl = "";
  
              // Loop over the lines in this block looking for tight lists.
              tight_search:
              for ( var line_no = 0; line_no < lines.length; line_no++ ) {
                nl = "";
                var l = lines[line_no].replace(/^\n/, function(n) { nl = n; return ""; });
  
  
                // TODO: really should cache this
                var line_re = regex_for_depth( stack.length );
  
                m = l.match( line_re );
                //print( "line:", uneval(l), "\nline match:", uneval(m) );
  
                // We have a list item
                if ( m[1] !== undefined ) {
                  // Process the previous list item, if any
                  if ( li_accumulate.length ) {
                    add( last_li, loose, this.processInline( li_accumulate ), nl );
                    // Loose mode will have been dealt with. Reset it
                    loose = false;
                    li_accumulate = "";
                  }
  
                  m[1] = expand_tab( m[1] );
                  var wanted_depth = Math.floor(m[1].length/4)+1;
                  //print( "want:", wanted_depth, "stack:", stack.length);
                  if ( wanted_depth > stack.length ) {
                    // Deep enough for a nested list outright
                    //print ( "new nested list" );
                    list = make_list( m );
                    last_li.push( list );
                    last_li = list[1] = [ "listitem" ];
                  }
                  else {
                    // We aren't deep enough to be strictly a new level. This is
                    // where Md.pl goes nuts. If the indent matches a level in the
                    // stack, put it there, else put it one deeper then the
                    // wanted_depth deserves.
                    var found = false;
                    for ( i = 0; i < stack.length; i++ ) {
                      if ( stack[ i ].indent !== m[1] )
                        continue;
  
                      list = stack[ i ].list;
                      stack.splice( i+1, stack.length - (i+1) );
                      found = true;
                      break;
                    }
  
                    if (!found) {
                      //print("not found. l:", uneval(l));
                      wanted_depth++;
                      if ( wanted_depth <= stack.length ) {
                        stack.splice(wanted_depth, stack.length - wanted_depth);
                        //print("Desired depth now", wanted_depth, "stack:", stack.length);
                        list = stack[wanted_depth-1].list;
                        //print("list:", uneval(list) );
                      }
                      else {
                        //print ("made new stack for messy indent");
                        list = make_list(m);
                        last_li.push(list);
                      }
                    }
  
                    //print( uneval(list), "last", list === stack[stack.length-1].list );
                    last_li = [ "listitem" ];
                    list.push(last_li);
                  } // end depth of shenegains
                  nl = "";
                }
  
                // Add content
                if ( l.length > m[0].length )
                  li_accumulate += nl + l.substr( m[0].length );
              } // tight_search
  
              if ( li_accumulate.length ) {
                add( last_li, loose, this.processInline( li_accumulate ), nl );
                // Loose mode will have been dealt with. Reset it
                loose = false;
                li_accumulate = "";
              }
  
              // Look at the next block - we might have a loose list. Or an extra
              // paragraph for the current li
              var contained = get_contained_blocks( stack.length, next );
  
              // Deal with code blocks or properly nested lists
              if ( contained.length > 0 ) {
                // Make sure all listitems up the stack are paragraphs
                forEach( stack, paragraphify, this);
  
                last_li.push.apply( last_li, this.toTree( contained, [] ) );
              }
  
              var next_block = next[0] && next[0].valueOf() || "";
  
              if ( next_block.match(is_list_re) || next_block.match( /^ / ) ) {
                block = next.shift();
  
                // Check for an HR following a list: features/lists/hr_abutting
                var hr = this.dialect.block.horizRule( block, next );
  
                if ( hr ) {
                  ret.push.apply(ret, hr);
                  break;
                }
  
                // Make sure all listitems up the stack are paragraphs
                forEach( stack, paragraphify, this);
  
                loose = true;
                continue loose_search;
              }
              break;
            } // loose_search
  
            return ret;
          };
        })(),
  
        blockquote: function blockquote( block, next ) {
          if ( !block.match( /^>/m ) )
            return undefined;
  
          var jsonml = [];
  
          // separate out the leading abutting block, if any. I.e. in this case:
          //
          //  a
          //  > b
          //
          if ( block[ 0 ] !== ">" ) {
            var lines = block.split( /\n/ ),
                prev = [],
                line_no = block.lineNumber;
  
            // keep shifting lines until you find a crotchet
            while ( lines.length && lines[ 0 ][ 0 ] !== ">" ) {
              prev.push( lines.shift() );
              line_no++;
            }
  
            var abutting = mk_block( prev.join( "\n" ), "\n", block.lineNumber );
            jsonml.push.apply( jsonml, this.processBlock( abutting, [] ) );
            // reassemble new block of just block quotes!
            block = mk_block( lines.join( "\n" ), block.trailing, line_no );
          }
  
  
          // if the next block is also a blockquote merge it in
          while ( next.length && next[ 0 ][ 0 ] === ">" ) {
            var b = next.shift();
            block = mk_block( block + block.trailing + b, b.trailing, block.lineNumber );
          }
  
          // Strip off the leading "> " and re-process as a block.
          var input = block.replace( /^> ?/gm, "" ),
              old_tree = this.tree,
              processedBlock = this.toTree( input, [ "blockquote" ] ),
              attr = extract_attr( processedBlock );
  
          // If any link references were found get rid of them
          if ( attr && attr.references ) {
            delete attr.references;
            // And then remove the attribute object if it's empty
            if ( isEmpty( attr ) )
              processedBlock.splice( 1, 1 );
          }
  
          jsonml.push( processedBlock );
          return jsonml;
        },
  
        referenceDefn: function referenceDefn( block, next) {
          var re = /^\s*\[(.*?)\]:\s*(\S+)(?:\s+(?:(['"])(.*?)\3|\((.*?)\)))?\n?/;
          // interesting matches are [ , ref_id, url, , title, title ]
  
          if ( !block.match(re) )
            return undefined;
  
          // make an attribute node if it doesn't exist
          if ( !extract_attr( this.tree ) )
            this.tree.splice( 1, 0, {} );
  
          var attrs = extract_attr( this.tree );
  
          // make a references hash if it doesn't exist
          if ( attrs.references === undefined )
            attrs.references = {};
  
          var b = this.loop_re_over_block(re, block, function( m ) {
  
            if ( m[2] && m[2][0] === "<" && m[2][m[2].length-1] === ">" )
              m[2] = m[2].substring( 1, m[2].length - 1 );
  
            var ref = attrs.references[ m[1].toLowerCase() ] = {
              href: m[2]
            };
  
            if ( m[4] !== undefined )
              ref.title = m[4];
            else if ( m[5] !== undefined )
              ref.title = m[5];
  
          } );
  
          if ( b.length )
            next.unshift( mk_block( b, block.trailing ) );
  
          return [];
        },
  
        para: function para( block ) {
          // everything's a para!
          return [ ["para"].concat( this.processInline( block ) ) ];
        }
      },
  
      inline: {
  
        __oneElement__: function oneElement( text, patterns_or_re, previous_nodes ) {
          var m,
              res;
  
          patterns_or_re = patterns_or_re || this.dialect.inline.__patterns__;
          var re = new RegExp( "([\\s\\S]*?)(" + (patterns_or_re.source || patterns_or_re) + ")" );
  
          m = re.exec( text );
          if (!m) {
            // Just boring text
            return [ text.length, text ];
          }
          else if ( m[1] ) {
            // Some un-interesting text matched. Return that first
            return [ m[1].length, m[1] ];
          }
  
          var res;
          if ( m[2] in this.dialect.inline ) {
            res = this.dialect.inline[ m[2] ].call(
                      this,
                      text.substr( m.index ), m, previous_nodes || [] );
          }
          // Default for now to make dev easier. just slurp special and output it.
          res = res || [ m[2].length, m[2] ];
          return res;
        },
  
        __call__: function inline( text, patterns ) {
  
          var out = [],
              res;
  
          function add(x) {
            //D:self.debug("  adding output", uneval(x));
            if ( typeof x === "string" && typeof out[out.length-1] === "string" )
              out[ out.length-1 ] += x;
            else
              out.push(x);
          }
  
          while ( text.length > 0 ) {
            res = this.dialect.inline.__oneElement__.call(this, text, patterns, out );
            text = text.substr( res.shift() );
            forEach(res, add );
          }
  
          return out;
        },
  
        // These characters are intersting elsewhere, so have rules for them so that
        // chunks of plain text blocks don't include them
        "]": function () {},
        "}": function () {},
  
        __escape__ : /^\\[\\`\*_{}\[\]()#\+.!\-]/,
  
        "\\": function escaped( text ) {
          // [ length of input processed, node/children to add... ]
          // Only esacape: \ ` * _ { } [ ] ( ) # * + - . !
          if ( this.dialect.inline.__escape__.exec( text ) )
            return [ 2, text.charAt( 1 ) ];
          else
            // Not an esacpe
            return [ 1, "\\" ];
        },
  
        "![": function image( text ) {
  
          // Unlike images, alt text is plain text only. no other elements are
          // allowed in there
  
          // ![Alt text](/path/to/img.jpg "Optional title")
          //      1          2            3       4         <--- captures
          var m = text.match( /^!\[(.*?)\][ \t]*\([ \t]*([^")]*?)(?:[ \t]+(["'])(.*?)\3)?[ \t]*\)/ );
  
          if ( m ) {
            if ( m[2] && m[2][0] === "<" && m[2][m[2].length-1] === ">" )
              m[2] = m[2].substring( 1, m[2].length - 1 );
  
            m[2] = this.dialect.inline.__call__.call( this, m[2], /\\/ )[0];
  
            var attrs = { alt: m[1], href: m[2] || "" };
            if ( m[4] !== undefined)
              attrs.title = m[4];
  
            return [ m[0].length, [ "img", attrs ] ];
          }
  
          // ![Alt text][id]
          m = text.match( /^!\[(.*?)\][ \t]*\[(.*?)\]/ );
  
          if ( m ) {
            // We can't check if the reference is known here as it likely wont be
            // found till after. Check it in md tree->hmtl tree conversion
            return [ m[0].length, [ "img_ref", { alt: m[1], ref: m[2].toLowerCase(), original: m[0] } ] ];
          }
  
          // Just consume the '!['
          return [ 2, "![" ];
        },
  
        "[": function link( text ) {
  
          var orig = String(text);
          // Inline content is possible inside `link text`
          var res = inline_until_char.call( this, text.substr(1), "]" );
  
          // No closing ']' found. Just consume the [
          if ( !res )
            return [ 1, "[" ];
  
          var consumed = 1 + res[ 0 ],
              children = res[ 1 ],
              link,
              attrs;
  
          // At this point the first [...] has been parsed. See what follows to find
          // out which kind of link we are (reference or direct url)
          text = text.substr( consumed );
  
          // [link text](/path/to/img.jpg "Optional title")
          //                 1            2       3         <--- captures
          // This will capture up to the last paren in the block. We then pull
          // back based on if there a matching ones in the url
          //    ([here](/url/(test))
          // The parens have to be balanced
          var m = text.match( /^\s*\([ \t]*([^"']*)(?:[ \t]+(["'])(.*?)\2)?[ \t]*\)/ );
          if ( m ) {
            var url = m[1];
            consumed += m[0].length;
  
            if ( url && url[0] === "<" && url[url.length-1] === ">" )
              url = url.substring( 1, url.length - 1 );
  
            // If there is a title we don't have to worry about parens in the url
            if ( !m[3] ) {
              var open_parens = 1; // One open that isn't in the capture
              for ( var len = 0; len < url.length; len++ ) {
                switch ( url[len] ) {
                case "(":
                  open_parens++;
                  break;
                case ")":
                  if ( --open_parens === 0) {
                    consumed -= url.length - len;
                    url = url.substring(0, len);
                  }
                  break;
                }
              }
            }
  
            // Process escapes only
            url = this.dialect.inline.__call__.call( this, url, /\\/ )[0];
  
            attrs = { href: url || "" };
            if ( m[3] !== undefined)
              attrs.title = m[3];
  
            link = [ "link", attrs ].concat( children );
            return [ consumed, link ];
          }
  
          // [Alt text][id]
          // [Alt text] [id]
          m = text.match( /^\s*\[(.*?)\]/ );
  
          if ( m ) {
  
            consumed += m[ 0 ].length;
  
            // [links][] uses links as its reference
            attrs = { ref: ( m[ 1 ] || String(children) ).toLowerCase(),  original: orig.substr( 0, consumed ) };
  
            link = [ "link_ref", attrs ].concat( children );
  
            // We can't check if the reference is known here as it likely wont be
            // found till after. Check it in md tree->hmtl tree conversion.
            // Store the original so that conversion can revert if the ref isn't found.
            return [ consumed, link ];
          }
  
          // [id]
          // Only if id is plain (no formatting.)
          if ( children.length === 1 && typeof children[0] === "string" ) {
  
            attrs = { ref: children[0].toLowerCase(),  original: orig.substr( 0, consumed ) };
            link = [ "link_ref", attrs, children[0] ];
            return [ consumed, link ];
          }
  
          // Just consume the "["
          return [ 1, "[" ];
        },
  
  
        "<": function autoLink( text ) {
          var m;
  
          if ( ( m = text.match( /^<(?:((https?|ftp|mailto):[^>]+)|(.*?@.*?\.[a-zA-Z]+))>/ ) ) !== null ) {
            if ( m[3] )
              return [ m[0].length, [ "link", { href: "mailto:" + m[3] }, m[3] ] ];
            else if ( m[2] === "mailto" )
              return [ m[0].length, [ "link", { href: m[1] }, m[1].substr("mailto:".length ) ] ];
            else
              return [ m[0].length, [ "link", { href: m[1] }, m[1] ] ];
          }
  
          return [ 1, "<" ];
        },
  
        "`": function inlineCode( text ) {
          // Inline code block. as many backticks as you like to start it
          // Always skip over the opening ticks.
          var m = text.match( /(`+)(([\s\S]*?)\1)/ );
  
          if ( m && m[2] )
            return [ m[1].length + m[2].length, [ "inlinecode", m[3] ] ];
          else {
            // TODO: No matching end code found - warn!
            return [ 1, "`" ];
          }
        },
  
        "  \n": function lineBreak() {
          return [ 3, [ "linebreak" ] ];
        }
  
      }
    };
  
    // Meta Helper/generator method for em and strong handling
    function strong_em( tag, md ) {
  
      var state_slot = tag + "_state",
          other_slot = tag === "strong" ? "em_state" : "strong_state";
  
      function CloseTag(len) {
        this.len_after = len;
        this.name = "close_" + md;
      }
  
      return function ( text ) {
  
        if ( this[state_slot][0] === md ) {
          // Most recent em is of this type
          //D:this.debug("closing", md);
          this[state_slot].shift();
  
          // "Consume" everything to go back to the recrusion in the else-block below
          return[ text.length, new CloseTag(text.length-md.length) ];
        }
        else {
          // Store a clone of the em/strong states
          var other = this[other_slot].slice(),
              state = this[state_slot].slice();
  
          this[state_slot].unshift(md);
  
          //D:this.debug_indent += "  ";
  
          // Recurse
          var res = this.processInline( text.substr( md.length ) );
          //D:this.debug_indent = this.debug_indent.substr(2);
  
          var last = res[res.length - 1];
  
          //D:this.debug("processInline from", tag + ": ", uneval( res ) );
  
          var check = this[state_slot].shift();
          if ( last instanceof CloseTag ) {
            res.pop();
            // We matched! Huzzah.
            var consumed = text.length - last.len_after;
            return [ consumed, [ tag ].concat(res) ];
          }
          else {
            // Restore the state of the other kind. We might have mistakenly closed it.
            this[other_slot] = other;
            this[state_slot] = state;
  
            // We can't reuse the processed result as it could have wrong parsing contexts in it.
            return [ md.length, md ];
          }
        }
      }; // End returned function
    }
  
    Gruber.inline["**"] = strong_em("strong", "**");
    Gruber.inline["__"] = strong_em("strong", "__");
    Gruber.inline["*"]  = strong_em("em", "*");
    Gruber.inline["_"]  = strong_em("em", "_");
  
    Markdown.dialects.Gruber = Gruber;
    Markdown.buildBlockOrder ( Markdown.dialects.Gruber.block );
    Markdown.buildInlinePatterns( Markdown.dialects.Gruber.inline );
  
  
  
    var Maruku = DialectHelpers.subclassDialect( Gruber ),
        extract_attr = MarkdownHelpers.extract_attr,
        forEach = MarkdownHelpers.forEach;
  
    Maruku.processMetaHash = function processMetaHash( meta_string ) {
      var meta = split_meta_hash( meta_string ),
          attr = {};
  
      for ( var i = 0; i < meta.length; ++i ) {
        // id: #foo
        if ( /^#/.test( meta[ i ] ) )
          attr.id = meta[ i ].substring( 1 );
        // class: .foo
        else if ( /^\./.test( meta[ i ] ) ) {
          // if class already exists, append the new one
          if ( attr["class"] )
            attr["class"] = attr["class"] + meta[ i ].replace( /./, " " );
          else
            attr["class"] = meta[ i ].substring( 1 );
        }
        // attribute: foo=bar
        else if ( /\=/.test( meta[ i ] ) ) {
          var s = meta[ i ].split( /\=/ );
          attr[ s[ 0 ] ] = s[ 1 ];
        }
      }
  
      return attr;
    };
  
    function split_meta_hash( meta_string ) {
      var meta = meta_string.split( "" ),
          parts = [ "" ],
          in_quotes = false;
  
      while ( meta.length ) {
        var letter = meta.shift();
        switch ( letter ) {
        case " " :
          // if we're in a quoted section, keep it
          if ( in_quotes )
            parts[ parts.length - 1 ] += letter;
          // otherwise make a new part
          else
            parts.push( "" );
          break;
        case "'" :
        case '"' :
          // reverse the quotes and move straight on
          in_quotes = !in_quotes;
          break;
        case "\\" :
          // shift off the next letter to be used straight away.
          // it was escaped so we'll keep it whatever it is
          letter = meta.shift();
          /* falls through */
        default :
          parts[ parts.length - 1 ] += letter;
          break;
        }
      }
  
      return parts;
    }
  
    Maruku.block.document_meta = function document_meta( block ) {
      // we're only interested in the first block
      if ( block.lineNumber > 1 )
        return undefined;
  
      // document_meta blocks consist of one or more lines of `Key: Value\n`
      if ( ! block.match( /^(?:\w+:.*\n)*\w+:.*$/ ) )
        return undefined;
  
      // make an attribute node if it doesn't exist
      if ( !extract_attr( this.tree ) )
        this.tree.splice( 1, 0, {} );
  
      var pairs = block.split( /\n/ );
      for ( var p in pairs ) {
        var m = pairs[ p ].match( /(\w+):\s*(.*)$/ ),
            key = m[ 1 ].toLowerCase(),
            value = m[ 2 ];
  
        this.tree[ 1 ][ key ] = value;
      }
  
      // document_meta produces no content!
      return [];
    };
  
    Maruku.block.block_meta = function block_meta( block ) {
      // check if the last line of the block is an meta hash
      var m = block.match( /(^|\n) {0,3}\{:\s*((?:\\\}|[^\}])*)\s*\}$/ );
      if ( !m )
        return undefined;
  
      // process the meta hash
      var attr = this.dialect.processMetaHash( m[ 2 ] ),
          hash;
  
      // if we matched ^ then we need to apply meta to the previous block
      if ( m[ 1 ] === "" ) {
        var node = this.tree[ this.tree.length - 1 ];
        hash = extract_attr( node );
  
        // if the node is a string (rather than JsonML), bail
        if ( typeof node === "string" )
          return undefined;
  
        // create the attribute hash if it doesn't exist
        if ( !hash ) {
          hash = {};
          node.splice( 1, 0, hash );
        }
  
        // add the attributes in
        for ( var a in attr )
          hash[ a ] = attr[ a ];
  
        // return nothing so the meta hash is removed
        return [];
      }
  
      // pull the meta hash off the block and process what's left
      var b = block.replace( /\n.*$/, "" ),
          result = this.processBlock( b, [] );
  
      // get or make the attributes hash
      hash = extract_attr( result[ 0 ] );
      if ( !hash ) {
        hash = {};
        result[ 0 ].splice( 1, 0, hash );
      }
  
      // attach the attributes to the block
      for ( var a in attr )
        hash[ a ] = attr[ a ];
  
      return result;
    };
  
    Maruku.block.definition_list = function definition_list( block, next ) {
      // one or more terms followed by one or more definitions, in a single block
      var tight = /^((?:[^\s:].*\n)+):\s+([\s\S]+)$/,
          list = [ "dl" ],
          i, m;
  
      // see if we're dealing with a tight or loose block
      if ( ( m = block.match( tight ) ) ) {
        // pull subsequent tight DL blocks out of `next`
        var blocks = [ block ];
        while ( next.length && tight.exec( next[ 0 ] ) )
          blocks.push( next.shift() );
  
        for ( var b = 0; b < blocks.length; ++b ) {
          var m = blocks[ b ].match( tight ),
              terms = m[ 1 ].replace( /\n$/, "" ).split( /\n/ ),
              defns = m[ 2 ].split( /\n:\s+/ );
  
          // print( uneval( m ) );
  
          for ( i = 0; i < terms.length; ++i )
            list.push( [ "dt", terms[ i ] ] );
  
          for ( i = 0; i < defns.length; ++i ) {
            // run inline processing over the definition
            list.push( [ "dd" ].concat( this.processInline( defns[ i ].replace( /(\n)\s+/, "$1" ) ) ) );
          }
        }
      }
      else {
        return undefined;
      }
  
      return [ list ];
    };
  
    // splits on unescaped instances of @ch. If @ch is not a character the result
    // can be unpredictable
  
    Maruku.block.table = function table ( block ) {
  
      var _split_on_unescaped = function( s, ch ) {
        ch = ch || '\\s';
        if ( ch.match(/^[\\|\[\]{}?*.+^$]$/) )
          ch = '\\' + ch;
        var res = [ ],
            r = new RegExp('^((?:\\\\.|[^\\\\' + ch + '])*)' + ch + '(.*)'),
            m;
        while ( ( m = s.match( r ) ) ) {
          res.push( m[1] );
          s = m[2];
        }
        res.push(s);
        return res;
      };
  
      var leading_pipe = /^ {0,3}\|(.+)\n {0,3}\|\s*([\-:]+[\-| :]*)\n((?:\s*\|.*(?:\n|$))*)(?=\n|$)/,
          // find at least an unescaped pipe in each line
          no_leading_pipe = /^ {0,3}(\S(?:\\.|[^\\|])*\|.*)\n {0,3}([\-:]+\s*\|[\-| :]*)\n((?:(?:\\.|[^\\|])*\|.*(?:\n|$))*)(?=\n|$)/,
          i,
          m;
      if ( ( m = block.match( leading_pipe ) ) ) {
        // remove leading pipes in contents
        // (header and horizontal rule already have the leading pipe left out)
        m[3] = m[3].replace(/^\s*\|/gm, '');
      } else if ( ! ( m = block.match( no_leading_pipe ) ) ) {
        return undefined;
      }
  
      var table = [ "table", [ "thead", [ "tr" ] ], [ "tbody" ] ];
  
      // remove trailing pipes, then split on pipes
      // (no escaped pipes are allowed in horizontal rule)
      m[2] = m[2].replace(/\|\s*$/, '').split('|');
  
      // process alignment
      var html_attrs = [ ];
      forEach (m[2], function (s) {
        if (s.match(/^\s*-+:\s*$/))
          html_attrs.push({align: "right"});
        else if (s.match(/^\s*:-+\s*$/))
          html_attrs.push({align: "left"});
        else if (s.match(/^\s*:-+:\s*$/))
          html_attrs.push({align: "center"});
        else
          html_attrs.push({});
      });
  
      // now for the header, avoid escaped pipes
      m[1] = _split_on_unescaped(m[1].replace(/\|\s*$/, ''), '|');
      for (i = 0; i < m[1].length; i++) {
        table[1][1].push(['th', html_attrs[i] || {}].concat(
          this.processInline(m[1][i].trim())));
      }
  
      // now for body contents
      forEach (m[3].replace(/\|\s*$/mg, '').split('\n'), function (row) {
        var html_row = ['tr'];
        row = _split_on_unescaped(row, '|');
        for (i = 0; i < row.length; i++)
          html_row.push(['td', html_attrs[i] || {}].concat(this.processInline(row[i].trim())));
        table[2].push(html_row);
      }, this);
  
      return [table];
    };
  
    Maruku.inline[ "{:" ] = function inline_meta( text, matches, out ) {
      if ( !out.length )
        return [ 2, "{:" ];
  
      // get the preceeding element
      var before = out[ out.length - 1 ];
  
      if ( typeof before === "string" )
        return [ 2, "{:" ];
  
      // match a meta hash
      var m = text.match( /^\{:\s*((?:\\\}|[^\}])*)\s*\}/ );
  
      // no match, false alarm
      if ( !m )
        return [ 2, "{:" ];
  
      // attach the attributes to the preceeding element
      var meta = this.dialect.processMetaHash( m[ 1 ] ),
          attr = extract_attr( before );
  
      if ( !attr ) {
        attr = {};
        before.splice( 1, 0, attr );
      }
  
      for ( var k in meta )
        attr[ k ] = meta[ k ];
  
      // cut out the string and replace it with nothing
      return [ m[ 0 ].length, "" ];
    };
  
  
    Markdown.dialects.Maruku = Maruku;
    Markdown.dialects.Maruku.inline.__escape__ = /^\\[\\`\*_{}\[\]()#\+.!\-|:]/;
    Markdown.buildBlockOrder ( Markdown.dialects.Maruku.block );
    Markdown.buildInlinePatterns( Markdown.dialects.Maruku.inline );
  
  
  // Include all our depndencies and;
    expose.Markdown = Markdown;
    expose.parse = Markdown.parse;
    expose.toHTML = Markdown.toHTML;
    expose.toHTMLTree = Markdown.toHTMLTree;
    expose.renderJsonML = Markdown.renderJsonML;
  
  })(function() {
    window.markdown = {};
    return window.markdown;
  }());
  
  
  // This file was automatically generated from files in src/ directory.
  
  /*! Licensed under MIT License - http://github.com/impress/impress.js */
  /**
   * impress.js
   *
   * impress.js is a presentation tool based on the power of CSS3 transforms and transitions
   * in modern browsers and inspired by the idea behind prezi.com.
   *
   *
   * Copyright 2011-2012 Bartek Szopka (@bartaz), 2016-2020 Henrik Ingo (@henrikingo)
   *
   * Released under the MIT License.
   *
   * ------------------------------------------------
   *  author:  Bartek Szopka, Henrik Ingo
   *  version: 1.1.0
   *  url:     http://impress.js.org
   *  source:  http://github.com/impress/impress.js/
   */
  
  // You are one of those who like to know how things work inside?
  // Let me show you the cogs that make impress.js run...
  ( function( document, window ) {
      "use strict";
      var lib;
  
      // HELPER FUNCTIONS
  
      // `pfx` is a function that takes a standard CSS property name as a parameter
      // and returns it's prefixed version valid for current browser it runs in.
      // The code is heavily inspired by Modernizr http://www.modernizr.com/
      var pfx = ( function() {
  
          var style = document.createElement( "dummy" ).style,
              prefixes = "Webkit Moz O ms Khtml".split( " " ),
              memory = {};
  
          return function( prop ) {
              if ( typeof memory[ prop ] === "undefined" ) {
  
                  var ucProp  = prop.charAt( 0 ).toUpperCase() + prop.substr( 1 ),
                      props   = ( prop + " " + prefixes.join( ucProp + " " ) + ucProp ).split( " " );
  
                  memory[ prop ] = null;
                  for ( var i in props ) {
                      if ( style[ props[ i ] ] !== undefined ) {
                          memory[ prop ] = props[ i ];
                          break;
                      }
                  }
  
              }
  
              return memory[ prop ];
          };
  
      } )();
  
      var validateOrder = function( order, fallback ) {
          var validChars = "xyz";
          var returnStr = "";
          if ( typeof order === "string" ) {
              for ( var i in order.split( "" ) ) {
                  if ( validChars.indexOf( order[ i ] ) >= 0 ) {
                      returnStr += order[ i ];
  
                      // Each of x,y,z can be used only once.
                      validChars = validChars.split( order[ i ] ).join( "" );
                  }
              }
          }
          if ( returnStr ) {
              return returnStr;
          } else if ( fallback !== undefined ) {
              return fallback;
          } else {
              return "xyz";
          }
      };
  
      // `css` function applies the styles given in `props` object to the element
      // given as `el`. It runs all property names through `pfx` function to make
      // sure proper prefixed version of the property is used.
      var css = function( el, props ) {
          var key, pkey;
          for ( key in props ) {
              if ( props.hasOwnProperty( key ) ) {
                  pkey = pfx( key );
                  if ( pkey !== null ) {
                      el.style[ pkey ] = props[ key ];
                  }
              }
          }
          return el;
      };
  
      // `translate` builds a translate transform string for given data.
      var translate = function( t ) {
          return " translate3d(" + t.x + "px," + t.y + "px," + t.z + "px) ";
      };
  
      // `rotate` builds a rotate transform string for given data.
      // By default the rotations are in X Y Z order that can be reverted by passing `true`
      // as second parameter.
      var rotate = function( r, revert ) {
          var order = r.order ? r.order : "xyz";
          var css = "";
          var axes = order.split( "" );
          if ( revert ) {
              axes = axes.reverse();
          }
  
          for ( var i = 0; i < axes.length; i++ ) {
              css += " rotate" + axes[ i ].toUpperCase() + "(" + r[ axes[ i ] ] + "deg)";
          }
          return css;
      };
  
      // `scale` builds a scale transform string for given data.
      var scale = function( s ) {
          return " scale(" + s + ") ";
      };
  
      // `computeWindowScale` counts the scale factor between window size and size
      // defined for the presentation in the config.
      var computeWindowScale = function( config ) {
          var hScale = window.innerHeight / config.height,
              wScale = window.innerWidth / config.width,
              scale = hScale > wScale ? wScale : hScale;
  
          if ( config.maxScale && scale > config.maxScale ) {
              scale = config.maxScale;
          }
  
          if ( config.minScale && scale < config.minScale ) {
              scale = config.minScale;
          }
  
          return scale;
      };
  
      // CHECK SUPPORT
      var body = document.body;
      var impressSupported =
  
                            // Browser should support CSS 3D transtorms
                             ( pfx( "perspective" ) !== null ) &&
  
                            // And `classList` and `dataset` APIs
                             ( body.classList ) &&
                             ( body.dataset );
  
      if ( !impressSupported ) {
  
          // We can't be sure that `classList` is supported
          body.className += " impress-not-supported ";
      }
  
      // GLOBALS AND DEFAULTS
  
      // This is where the root elements of all impress.js instances will be kept.
      // Yes, this means you can have more than one instance on a page, but I'm not
      // sure if it makes any sense in practice ;)
      var roots = {};
  
      var preInitPlugins = [];
      var preStepLeavePlugins = [];
  
      // Some default config values.
      var defaults = {
          width: 1024,
          height: 768,
          maxScale: 1,
          minScale: 0,
  
          perspective: 1000,
  
          transitionDuration: 1000
      };
  
      // It's just an empty function ... and a useless comment.
      var empty = function() { return false; };
  
      // IMPRESS.JS API
  
      // And that's where interesting things will start to happen.
      // It's the core `impress` function that returns the impress.js API
      // for a presentation based on the element with given id ("impress"
      // by default).
      var impress = window.impress = function( rootId ) {
  
          // If impress.js is not supported by the browser return a dummy API
          // it may not be a perfect solution but we return early and avoid
          // running code that may use features not implemented in the browser.
          if ( !impressSupported ) {
              return {
                  init: empty,
                  goto: empty,
                  prev: empty,
                  next: empty,
                  swipe: empty,
                  tear: empty,
                  lib: {}
              };
          }
  
          rootId = rootId || "impress";
  
          // If given root is already initialized just return the API
          if ( roots[ "impress-root-" + rootId ] ) {
              return roots[ "impress-root-" + rootId ];
          }
  
          // The gc library depends on being initialized before we do any changes to DOM.
          lib = initLibraries( rootId );
  
          body.classList.remove( "impress-not-supported" );
          body.classList.add( "impress-supported" );
  
          // Data of all presentation steps
          var stepsData = {};
  
          // Element of currently active step
          var activeStep = null;
  
          // Current state (position, rotation and scale) of the presentation
          var currentState = null;
  
          // Array of step elements
          var steps = null;
  
          // Configuration options
          var config = null;
  
          // Scale factor of the browser window
          var windowScale = null;
  
          // Root presentation elements
          var root = lib.util.byId( rootId );
          var canvas = document.createElement( "div" );
  
          var initialized = false;
  
          // STEP EVENTS
          //
          // There are currently two step events triggered by impress.js
          // `impress:stepenter` is triggered when the step is shown on the
          // screen (the transition from the previous one is finished) and
          // `impress:stepleave` is triggered when the step is left (the
          // transition to next step just starts).
  
          // Reference to last entered step
          var lastEntered = null;
  
          // `onStepEnter` is called whenever the step element is entered
          // but the event is triggered only if the step is different than
          // last entered step.
          // We sometimes call `goto`, and therefore `onStepEnter`, just to redraw a step, such as
          // after screen resize. In this case - more precisely, in any case - we trigger a
          // `impress:steprefresh` event.
          var onStepEnter = function( step ) {
              if ( lastEntered !== step ) {
                  lib.util.triggerEvent( step, "impress:stepenter" );
                  lastEntered = step;
              }
              lib.util.triggerEvent( step, "impress:steprefresh" );
          };
  
          // `onStepLeave` is called whenever the currentStep element is left
          // but the event is triggered only if the currentStep is the same as
          // lastEntered step.
          var onStepLeave = function( currentStep, nextStep ) {
              if ( lastEntered === currentStep ) {
                  lib.util.triggerEvent( currentStep, "impress:stepleave", { next: nextStep } );
                  lastEntered = null;
              }
          };
  
          // `initStep` initializes given step element by reading data from its
          // data attributes and setting correct styles.
          var initStep = function( el, idx ) {
              var data = el.dataset,
                  step = {
                      translate: {
                          x: lib.util.toNumber( data.x ),
                          y: lib.util.toNumber( data.y ),
                          z: lib.util.toNumber( data.z )
                      },
                      rotate: {
                          x: lib.util.toNumber( data.rotateX ),
                          y: lib.util.toNumber( data.rotateY ),
                          z: lib.util.toNumber( data.rotateZ || data.rotate ),
                          order: validateOrder( data.rotateOrder )
                      },
                      scale: lib.util.toNumber( data.scale, 1 ),
                      transitionDuration: lib.util.toNumber(
                          data.transitionDuration, config.transitionDuration
                      ),
                      el: el
                  };
  
              if ( !el.id ) {
                  el.id = "step-" + ( idx + 1 );
              }
  
              stepsData[ "impress-" + el.id ] = step;
  
              css( el, {
                  position: "absolute",
                  transform: "translate(-50%,-50%)" +
                             translate( step.translate ) +
                             rotate( step.rotate ) +
                             scale( step.scale ),
                  transformStyle: "preserve-3d"
              } );
          };
  
          // Initialize all steps.
          // Read the data-* attributes, store in internal stepsData, and render with CSS.
          var initAllSteps = function() {
              steps = lib.util.$$( ".step", root );
              steps.forEach( initStep );
          };
  
          // `init` API function that initializes (and runs) the presentation.
          var init = function() {
              if ( initialized ) { return; }
              execPreInitPlugins( root );
  
              // First we set up the viewport for mobile devices.
              // For some reason iPad goes nuts when it is not done properly.
              var meta = lib.util.$( "meta[name='viewport']" ) || document.createElement( "meta" );
              meta.content = "width=device-width, minimum-scale=1, maximum-scale=1, user-scalable=no";
              if ( meta.parentNode !== document.head ) {
                  meta.name = "viewport";
                  document.head.appendChild( meta );
              }
  
              // Initialize configuration object
              var rootData = root.dataset;
              config = {
                  width: lib.util.toNumber( rootData.width, defaults.width ),
                  height: lib.util.toNumber( rootData.height, defaults.height ),
                  maxScale: lib.util.toNumber( rootData.maxScale, defaults.maxScale ),
                  minScale: lib.util.toNumber( rootData.minScale, defaults.minScale ),
                  perspective: lib.util.toNumber( rootData.perspective, defaults.perspective ),
                  transitionDuration: lib.util.toNumber(
                      rootData.transitionDuration, defaults.transitionDuration
                  )
              };
  
              windowScale = computeWindowScale( config );
  
              // Wrap steps with "canvas" element
              lib.util.arrayify( root.childNodes ).forEach( function( el ) {
                  canvas.appendChild( el );
              } );
              root.appendChild( canvas );
  
              // Set initial styles
              document.documentElement.style.height = "100%";
  
              css( body, {
                  height: "100%",
                  overflow: "hidden"
              } );
  
              var rootStyles = {
                  position: "absolute",
                  transformOrigin: "top left",
                  transition: "all 0s ease-in-out",
                  transformStyle: "preserve-3d"
              };
  
              css( root, rootStyles );
              css( root, {
                  top: "50%",
                  left: "50%",
                  perspective: ( config.perspective / windowScale ) + "px",
                  transform: scale( windowScale )
              } );
              css( canvas, rootStyles );
  
              body.classList.remove( "impress-disabled" );
              body.classList.add( "impress-enabled" );
  
              // Get and init steps
              initAllSteps();
  
              // Set a default initial state of the canvas
              currentState = {
                  translate: { x: 0, y: 0, z: 0 },
                  rotate:    { x: 0, y: 0, z: 0, order: "xyz" },
                  scale:     1
              };
  
              initialized = true;
  
              lib.util.triggerEvent( root, "impress:init",
                                     { api: roots[ "impress-root-" + rootId ] } );
          };
  
          // `getStep` is a helper function that returns a step element defined by parameter.
          // If a number is given, step with index given by the number is returned, if a string
          // is given step element with such id is returned, if DOM element is given it is returned
          // if it is a correct step element.
          var getStep = function( step ) {
              if ( typeof step === "number" ) {
                  step = step < 0 ? steps[ steps.length + step ] : steps[ step ];
              } else if ( typeof step === "string" ) {
                  step = lib.util.byId( step );
              }
              return ( step && step.id && stepsData[ "impress-" + step.id ] ) ? step : null;
          };
  
          // Used to reset timeout for `impress:stepenter` event
          var stepEnterTimeout = null;
  
          // `goto` API function that moves to step given as `el` parameter (by index, id or element).
          // `duration` optionally given as second parameter, is the transition duration in css.
          // `reason` is the string "next", "prev" or "goto" (default) and will be made available to
          // preStepLeave plugins.
          // `origEvent` may contain event that caused the call to goto, such as a key press event
          var goto = function( el, duration, reason, origEvent ) {
              reason = reason || "goto";
              origEvent = origEvent || null;
  
              if ( !initialized ) {
                  return false;
              }
  
              // Re-execute initAllSteps for each transition. This allows to edit step attributes
              // dynamically, such as change their coordinates, or even remove or add steps, and have
              // that change apply when goto() is called.
              initAllSteps();
  
              if ( !( el = getStep( el ) ) ) {
                  return false;
              }
  
              // Sometimes it's possible to trigger focus on first link with some keyboard action.
              // Browser in such a case tries to scroll the page to make this element visible
              // (even that body overflow is set to hidden) and it breaks our careful positioning.
              //
              // So, as a lousy (and lazy) workaround we will make the page scroll back to the top
              // whenever slide is selected
              //
              // If you are reading this and know any better way to handle it, I'll be glad to hear
              // about it!
              window.scrollTo( 0, 0 );
  
              var step = stepsData[ "impress-" + el.id ];
              duration = ( duration !== undefined ? duration : step.transitionDuration );
  
              // If we are in fact moving to another step, start with executing the registered
              // preStepLeave plugins.
              if ( activeStep && activeStep !== el ) {
                  var event = { target: activeStep, detail: {} };
                  event.detail.next = el;
                  event.detail.transitionDuration = duration;
                  event.detail.reason = reason;
                  if ( origEvent ) {
                      event.origEvent = origEvent;
                  }
  
                  if ( execPreStepLeavePlugins( event ) === false ) {
  
                      // PreStepLeave plugins are allowed to abort the transition altogether, by
                      // returning false.
                      // see stop and substep plugins for an example of doing just that
                      return false;
                  }
  
                  // Plugins are allowed to change the detail values
                  el = event.detail.next;
                  step = stepsData[ "impress-" + el.id ];
                  duration = event.detail.transitionDuration;
              }
  
              if ( activeStep ) {
                  activeStep.classList.remove( "active" );
                  body.classList.remove( "impress-on-" + activeStep.id );
              }
              el.classList.add( "active" );
  
              body.classList.add( "impress-on-" + el.id );
  
              // Compute target state of the canvas based on given step
              var target = {
                  rotate: {
                      x: -step.rotate.x,
                      y: -step.rotate.y,
                      z: -step.rotate.z,
                      order: step.rotate.order
                  },
                  translate: {
                      x: -step.translate.x,
                      y: -step.translate.y,
                      z: -step.translate.z
                  },
                  scale: 1 / step.scale
              };
  
              // Check if the transition is zooming in or not.
              //
              // This information is used to alter the transition style:
              // when we are zooming in - we start with move and rotate transition
              // and the scaling is delayed, but when we are zooming out we start
              // with scaling down and move and rotation are delayed.
              var zoomin = target.scale >= currentState.scale;
  
              duration = lib.util.toNumber( duration, config.transitionDuration );
              var delay = ( duration / 2 );
  
              // If the same step is re-selected, force computing window scaling,
              // because it is likely to be caused by window resize
              if ( el === activeStep ) {
                  windowScale = computeWindowScale( config );
              }
  
              var targetScale = target.scale * windowScale;
  
              // Trigger leave of currently active element (if it's not the same step again)
              if ( activeStep && activeStep !== el ) {
                  onStepLeave( activeStep, el );
              }
  
              // Now we alter transforms of `root` and `canvas` to trigger transitions.
              //
              // And here is why there are two elements: `root` and `canvas` - they are
              // being animated separately:
              // `root` is used for scaling and `canvas` for translate and rotations.
              // Transitions on them are triggered with different delays (to make
              // visually nice and "natural" looking transitions), so we need to know
              // that both of them are finished.
              css( root, {
  
                  // To keep the perspective look similar for different scales
                  // we need to "scale" the perspective, too
                  // For IE 11 support we must specify perspective independent
                  // of transform.
                  perspective: ( config.perspective / targetScale ) + "px",
                  transform: scale( targetScale ),
                  transitionDuration: duration + "ms",
                  transitionDelay: ( zoomin ? delay : 0 ) + "ms"
              } );
  
              css( canvas, {
                  transform: rotate( target.rotate, true ) + translate( target.translate ),
                  transitionDuration: duration + "ms",
                  transitionDelay: ( zoomin ? 0 : delay ) + "ms"
              } );
  
              // Here is a tricky part...
              //
              // If there is no change in scale or no change in rotation and translation, it means
              // there was actually no delay - because there was no transition on `root` or `canvas`
              // elements. We want to trigger `impress:stepenter` event in the correct moment, so
              // here we compare the current and target values to check if delay should be taken into
              // account.
              //
              // I know that this `if` statement looks scary, but it's pretty simple when you know
              // what is going on - it's simply comparing all the values.
              if ( currentState.scale === target.scale ||
                  ( currentState.rotate.x === target.rotate.x &&
                    currentState.rotate.y === target.rotate.y &&
                    currentState.rotate.z === target.rotate.z &&
                    currentState.translate.x === target.translate.x &&
                    currentState.translate.y === target.translate.y &&
                    currentState.translate.z === target.translate.z ) ) {
                  delay = 0;
              }
  
              // Store current state
              currentState = target;
              activeStep = el;
  
              // And here is where we trigger `impress:stepenter` event.
              // We simply set up a timeout to fire it taking transition duration (and possible delay)
              // into account.
              //
              // I really wanted to make it in more elegant way. The `transitionend` event seemed to
              // be the best way to do it, but the fact that I'm using transitions on two separate
              // elements and that the `transitionend` event is only triggered when there was a
              // transition (change in the values) caused some bugs and made the code really
              // complicated, cause I had to handle all the conditions separately. And it still
              // needed a `setTimeout` fallback for the situations when there is no transition at all.
              // So I decided that I'd rather make the code simpler than use shiny new
              // `transitionend`.
              //
              // If you want learn something interesting and see how it was done with `transitionend`
              // go back to version 0.5.2 of impress.js:
              // http://github.com/bartaz/impress.js/blob/0.5.2/js/impress.js
              window.clearTimeout( stepEnterTimeout );
              stepEnterTimeout = window.setTimeout( function() {
                  onStepEnter( activeStep );
              }, duration + delay );
  
              return el;
          };
  
          // `prev` API function goes to previous step (in document order)
          // `event` is optional, may contain the event that caused the need to call prev()
          var prev = function( origEvent ) {
              var prev = steps.indexOf( activeStep ) - 1;
              prev = prev >= 0 ? steps[ prev ] : steps[ steps.length - 1 ];
  
              return goto( prev, undefined, "prev", origEvent );
          };
  
          // `next` API function goes to next step (in document order)
          // `event` is optional, may contain the event that caused the need to call next()
          var next = function( origEvent ) {
              var next = steps.indexOf( activeStep ) + 1;
              next = next < steps.length ? steps[ next ] : steps[ 0 ];
  
              return goto( next, undefined, "next", origEvent );
          };
  
          // Swipe for touch devices by @and3rson.
          // Below we extend the api to control the animation between the currently
          // active step and a presumed next/prev step. See touch plugin for
          // an example of using this api.
  
          // Helper function
          var interpolate = function( a, b, k ) {
              return a + ( b - a ) * k;
          };
  
          // Animate a swipe.
          //
          // Pct is a value between -1.0 and +1.0, designating the current length
          // of the swipe.
          //
          // If pct is negative, swipe towards the next() step, if positive,
          // towards the prev() step.
          //
          // Note that pre-stepleave plugins such as goto can mess with what is a
          // next() and prev() step, so we need to trigger the pre-stepleave event
          // here, even if a swipe doesn't guarantee that the transition will
          // actually happen.
          //
          // Calling swipe(), with any value of pct, won't in itself cause a
          // transition to happen, this is just to animate the swipe. Once the
          // transition is committed - such as at a touchend event - caller is
          // responsible for also calling prev()/next() as appropriate.
          //
          // Note: For now, this function is made available to be used by the swipe plugin (which
          // is the UI counterpart to this). It is a semi-internal API and intentionally not
          // documented in DOCUMENTATION.md.
          var swipe = function( pct ) {
              if ( Math.abs( pct ) > 1 ) {
                  return;
              }
  
              // Prepare & execute the preStepLeave event
              var event = { target: activeStep, detail: {} };
              event.detail.swipe = pct;
  
              // Will be ignored within swipe animation, but just in case a plugin wants to read this,
              // humor them
              event.detail.transitionDuration = config.transitionDuration;
              var idx; // Needed by jshint
              if ( pct < 0 ) {
                  idx = steps.indexOf( activeStep ) + 1;
                  event.detail.next = idx < steps.length ? steps[ idx ] : steps[ 0 ];
                  event.detail.reason = "next";
              } else if ( pct > 0 ) {
                  idx = steps.indexOf( activeStep ) - 1;
                  event.detail.next = idx >= 0 ? steps[ idx ] : steps[ steps.length - 1 ];
                  event.detail.reason = "prev";
              } else {
  
                  // No move
                  return;
              }
              if ( execPreStepLeavePlugins( event ) === false ) {
  
                  // If a preStepLeave plugin wants to abort the transition, don't animate a swipe
                  // For stop, this is probably ok. For substep, the plugin it self might want to do
                  // some animation, but that's not the current implementation.
                  return false;
              }
              var nextElement = event.detail.next;
  
              var nextStep = stepsData[ "impress-" + nextElement.id ];
  
              // If the same step is re-selected, force computing window scaling,
              var nextScale = nextStep.scale * windowScale;
              var k = Math.abs( pct );
  
              var interpolatedStep = {
                  translate: {
                      x: interpolate( currentState.translate.x, -nextStep.translate.x, k ),
                      y: interpolate( currentState.translate.y, -nextStep.translate.y, k ),
                      z: interpolate( currentState.translate.z, -nextStep.translate.z, k )
                  },
                  rotate: {
                      x: interpolate( currentState.rotate.x, -nextStep.rotate.x, k ),
                      y: interpolate( currentState.rotate.y, -nextStep.rotate.y, k ),
                      z: interpolate( currentState.rotate.z, -nextStep.rotate.z, k ),
  
                      // Unfortunately there's a discontinuity if rotation order changes. Nothing I
                      // can do about it?
                      order: k < 0.7 ? currentState.rotate.order : nextStep.rotate.order
                  },
                  scale: interpolate( currentState.scale * windowScale, nextScale, k )
              };
  
              css( root, {
  
                  // To keep the perspective look similar for different scales
                  // we need to 'scale' the perspective, too
                  perspective: config.perspective / interpolatedStep.scale + "px",
                  transform: scale( interpolatedStep.scale ),
                  transitionDuration: "0ms",
                  transitionDelay: "0ms"
              } );
  
              css( canvas, {
                  transform: rotate( interpolatedStep.rotate, true ) +
                             translate( interpolatedStep.translate ),
                  transitionDuration: "0ms",
                  transitionDelay: "0ms"
              } );
          };
  
          // Teardown impress
          // Resets the DOM to the state it was before impress().init() was called.
          // (If you called impress(rootId).init() for multiple different rootId's, then you must
          // also call tear() once for each of them.)
          var tear = function() {
              lib.gc.teardown();
              delete roots[ "impress-root-" + rootId ];
          };
  
          // Adding some useful classes to step elements.
          //
          // All the steps that have not been shown yet are given `future` class.
          // When the step is entered the `future` class is removed and the `present`
          // class is given. When the step is left `present` class is replaced with
          // `past` class.
          //
          // So every step element is always in one of three possible states:
          // `future`, `present` and `past`.
          //
          // There classes can be used in CSS to style different types of steps.
          // For example the `present` class can be used to trigger some custom
          // animations when step is shown.
          lib.gc.addEventListener( root, "impress:init", function() {
  
              // STEP CLASSES
              steps.forEach( function( step ) {
                  step.classList.add( "future" );
              } );
  
              lib.gc.addEventListener( root, "impress:stepenter", function( event ) {
                  event.target.classList.remove( "past" );
                  event.target.classList.remove( "future" );
                  event.target.classList.add( "present" );
              }, false );
  
              lib.gc.addEventListener( root, "impress:stepleave", function( event ) {
                  event.target.classList.remove( "present" );
                  event.target.classList.add( "past" );
              }, false );
  
          }, false );
  
          // Adding hash change support.
          lib.gc.addEventListener( root, "impress:init", function() {
  
              // Last hash detected
              var lastHash = "";
  
              // `#/step-id` is used instead of `#step-id` to prevent default browser
              // scrolling to element in hash.
              //
              // And it has to be set after animation finishes, because in Chrome it
              // makes transtion laggy.
              // BUG: http://code.google.com/p/chromium/issues/detail?id=62820
              lib.gc.addEventListener( root, "impress:stepenter", function( event ) {
                  window.location.hash = lastHash = "#/" + event.target.id;
              }, false );
  
              lib.gc.addEventListener( window, "hashchange", function() {
  
                  // When the step is entered hash in the location is updated
                  // (just few lines above from here), so the hash change is
                  // triggered and we would call `goto` again on the same element.
                  //
                  // To avoid this we store last entered hash and compare.
                  if ( window.location.hash !== lastHash ) {
                      goto( lib.util.getElementFromHash() );
                  }
              }, false );
  
              // START
              // by selecting step defined in url or first step of the presentation
              goto( lib.util.getElementFromHash() || steps[ 0 ], 0 );
          }, false );
  
          body.classList.add( "impress-disabled" );
  
          // Store and return API for given impress.js root element
          return ( roots[ "impress-root-" + rootId ] = {
              init: init,
              goto: goto,
              next: next,
              prev: prev,
              swipe: swipe,
              tear: tear,
              lib: lib
          } );
  
      };
  
      // Flag that can be used in JS to check if browser have passed the support test
      impress.supported = impressSupported;
  
      // ADD and INIT LIBRARIES
      // Library factories are defined in src/lib/*.js, and register themselves by calling
      // impress.addLibraryFactory(libraryFactoryObject). They're stored here, and used to augment
      // the API with library functions when client calls impress(rootId).
      // See src/lib/README.md for clearer example.
      // (Advanced usage: For different values of rootId, a different instance of the libaries are
      // generated, in case they need to hold different state for different root elements.)
      var libraryFactories = {};
      impress.addLibraryFactory = function( obj ) {
          for ( var libname in obj ) {
              if ( obj.hasOwnProperty( libname ) ) {
                  libraryFactories[ libname ] = obj[ libname ];
              }
          }
      };
  
      // Call each library factory, and return the lib object that is added to the api.
      var initLibraries = function( rootId ) { //jshint ignore:line
          var lib = {};
          for ( var libname in libraryFactories ) {
              if ( libraryFactories.hasOwnProperty( libname ) ) {
                  if ( lib[ libname ] !== undefined ) {
                      throw "impress.js ERROR: Two libraries both tried to use libname: " +  libname;
                  }
                  lib[ libname ] = libraryFactories[ libname ]( rootId );
              }
          }
          return lib;
      };
  
      // `addPreInitPlugin` allows plugins to register a function that should
      // be run (synchronously) at the beginning of init, before
      // impress().init() itself executes.
      impress.addPreInitPlugin = function( plugin, weight ) {
          weight = parseInt( weight ) || 10;
          if ( weight <= 0 ) {
              throw "addPreInitPlugin: weight must be a positive integer";
          }
  
          if ( preInitPlugins[ weight ] === undefined ) {
              preInitPlugins[ weight ] = [];
          }
          preInitPlugins[ weight ].push( plugin );
      };
  
      // Called at beginning of init, to execute all pre-init plugins.
      var execPreInitPlugins = function( root ) { //jshint ignore:line
          for ( var i = 0; i < preInitPlugins.length; i++ ) {
              var thisLevel = preInitPlugins[ i ];
              if ( thisLevel !== undefined ) {
                  for ( var j = 0; j < thisLevel.length; j++ ) {
                      thisLevel[ j ]( root );
                  }
              }
          }
      };
  
      // `addPreStepLeavePlugin` allows plugins to register a function that should
      // be run (synchronously) at the beginning of goto()
      impress.addPreStepLeavePlugin = function( plugin, weight ) { //jshint ignore:line
          weight = parseInt( weight ) || 10;
          if ( weight <= 0 ) {
              throw "addPreStepLeavePlugin: weight must be a positive integer";
          }
  
          if ( preStepLeavePlugins[ weight ] === undefined ) {
              preStepLeavePlugins[ weight ] = [];
          }
          preStepLeavePlugins[ weight ].push( plugin );
      };
  
      // Called at beginning of goto(), to execute all preStepLeave plugins.
      var execPreStepLeavePlugins = function( event ) { //jshint ignore:line
          for ( var i = 0; i < preStepLeavePlugins.length; i++ ) {
              var thisLevel = preStepLeavePlugins[ i ];
              if ( thisLevel !== undefined ) {
                  for ( var j = 0; j < thisLevel.length; j++ ) {
                      if ( thisLevel[ j ]( event ) === false ) {
  
                          // If a plugin returns false, the stepleave event (and related transition)
                          // is aborted
                          return false;
                      }
                  }
              }
          }
      };
  
  } )( document, window );
  
  // THAT'S ALL FOLKS!
  //
  // Thanks for reading it all.
  // Or thanks for scrolling down and reading the last part.
  //
  // I've learnt a lot when building impress.js and I hope this code and comments
  // will help somebody learn at least some part of it.
  
  /**
   * Garbage collection utility
   *
   * This library allows plugins to add elements and event listeners they add to the DOM. The user
   * can call `impress().lib.gc.teardown()` to cause all of them to be removed from DOM, so that
   * the document is in the state it was before calling `impress().init()`.
   *
   * In addition to just adding elements and event listeners to the garbage collector, plugins
   * can also register callback functions to do arbitrary cleanup upon teardown.
   *
   * Henrik Ingo (c) 2016
   * MIT License
   */
  
  ( function( document, window ) {
      "use strict";
      var roots = [];
      var rootsCount = 0;
      var startingState = { roots: [] };
  
      var libraryFactory = function( rootId ) {
          if ( roots[ rootId ] ) {
              return roots[ rootId ];
          }
  
          // Per root global variables (instance variables?)
          var elementList = [];
          var eventListenerList = [];
          var callbackList = [];
  
          recordStartingState( rootId );
  
          // LIBRARY FUNCTIONS
          // Definitions of the library functions we return as an object at the end
  
          // `pushElement` adds a DOM element to the gc stack
          var pushElement = function( element ) {
              elementList.push( element );
          };
  
          // `appendChild` is a convenience wrapper that combines DOM appendChild with gc.pushElement
          var appendChild = function( parent, element ) {
              parent.appendChild( element );
              pushElement( element );
          };
  
          // `pushEventListener` adds an event listener to the gc stack
          var pushEventListener = function( target, type, listenerFunction ) {
              eventListenerList.push( { target:target, type:type, listener:listenerFunction } );
          };
  
          // `addEventListener` combines DOM addEventListener with gc.pushEventListener
          var addEventListener = function( target, type, listenerFunction ) {
              target.addEventListener( type, listenerFunction );
              pushEventListener( target, type, listenerFunction );
          };
  
          // `pushCallback` If the above utilities are not enough, plugins can add their own callback
          // function to do arbitrary things.
          var pushCallback = function( callback ) {
              callbackList.push( callback );
          };
          pushCallback( function( rootId ) { resetStartingState( rootId ); } );
  
          // `teardown` will
          // - execute all callbacks in LIFO order
          // - call `removeChild` on all DOM elements in LIFO order
          // - call `removeEventListener` on all event listeners in LIFO order
          // The goal of a teardown is to return to the same state that the DOM was before
          // `impress().init()` was called.
          var teardown = function() {
  
              // Execute the callbacks in LIFO order
              var i; // Needed by jshint
              for ( i = callbackList.length - 1; i >= 0; i-- ) {
                  callbackList[ i ]( rootId );
              }
              callbackList = [];
              for ( i = 0; i < elementList.length; i++ ) {
                  elementList[ i ].parentElement.removeChild( elementList[ i ] );
              }
              elementList = [];
              for ( i = 0; i < eventListenerList.length; i++ ) {
                  var target   = eventListenerList[ i ].target;
                  var type     = eventListenerList[ i ].type;
                  var listener = eventListenerList[ i ].listener;
                  target.removeEventListener( type, listener );
              }
          };
  
          var lib = {
              pushElement: pushElement,
              appendChild: appendChild,
              pushEventListener: pushEventListener,
              addEventListener: addEventListener,
              pushCallback: pushCallback,
              teardown: teardown
          };
          roots[ rootId ] = lib;
          rootsCount++;
          return lib;
      };
  
      // Let impress core know about the existence of this library
      window.impress.addLibraryFactory( { gc: libraryFactory } );
  
      // CORE INIT
      // The library factory (gc(rootId)) is called at the beginning of impress(rootId).init()
      // For the purposes of teardown(), we can use this as an opportunity to save the state
      // of a few things in the DOM in their virgin state, before impress().init() did anything.
      // Note: These could also be recorded by the code in impress.js core as these values
      // are changed, but in an effort to not deviate too much from upstream, I'm adding
      // them here rather than the core itself.
      var recordStartingState = function( rootId ) {
          startingState.roots[ rootId ] = {};
          startingState.roots[ rootId ].steps = [];
  
          // Record whether the steps have an id or not
          var steps = document.getElementById( rootId ).querySelectorAll( ".step" );
          for ( var i = 0; i < steps.length; i++ ) {
              var el = steps[ i ];
              startingState.roots[ rootId ].steps.push( {
                  el: el,
                  id: el.getAttribute( "id" )
              } );
          }
  
          // In the rare case of multiple roots, the following is changed on first init() and
          // reset at last tear().
          if ( rootsCount === 0 ) {
              startingState.body = {};
  
              // It is customary for authors to set body.class="impress-not-supported" as a starting
              // value, which can then be removed by impress().init(). But it is not required.
              // Remember whether it was there or not.
              if ( document.body.classList.contains( "impress-not-supported" ) ) {
                  startingState.body.impressNotSupported = true;
              } else {
                  startingState.body.impressNotSupported = false;
              }
  
              // If there's a <meta name="viewport"> element, its contents will be overwritten by init
              var metas = document.head.querySelectorAll( "meta" );
              for ( i = 0; i < metas.length; i++ ) {
                  var m = metas[ i ];
                  if ( m.name === "viewport" ) {
                      startingState.meta = m.content;
                  }
              }
          }
      };
  
      // CORE TEARDOWN
      var resetStartingState = function( rootId ) {
  
          // Reset body element
          document.body.classList.remove( "impress-enabled" );
          document.body.classList.remove( "impress-disabled" );
  
          var root = document.getElementById( rootId );
          var activeId = root.querySelector( ".active" ).id;
          document.body.classList.remove( "impress-on-" + activeId );
  
          document.documentElement.style.height = "";
          document.body.style.height = "";
          document.body.style.overflow = "";
  
          // Remove style values from the root and step elements
          // Note: We remove the ones set by impress.js core. Otoh, we didn't preserve any original
          // values. A more sophisticated implementation could keep track of original values and then
          // reset those.
          var steps = root.querySelectorAll( ".step" );
          for ( var i = 0; i < steps.length; i++ ) {
              steps[ i ].classList.remove( "future" );
              steps[ i ].classList.remove( "past" );
              steps[ i ].classList.remove( "present" );
              steps[ i ].classList.remove( "active" );
              steps[ i ].style.position = "";
              steps[ i ].style.transform = "";
              steps[ i ].style[ "transform-style" ] = "";
          }
          root.style.position = "";
          root.style[ "transform-origin" ] = "";
          root.style.transition = "";
          root.style[ "transform-style" ] = "";
          root.style.top = "";
          root.style.left = "";
          root.style.transform = "";
  
          // Reset id of steps ("step-1" id's are auto generated)
          steps = startingState.roots[ rootId ].steps;
          var step;
          while ( step = steps.pop() ) {
              if ( step.id === null ) {
                  step.el.removeAttribute( "id" );
              } else {
                  step.el.setAttribute( "id", step.id );
              }
          }
          delete startingState.roots[ rootId ];
  
          // Move step div elements away from canvas, then delete canvas
          // Note: There's an implicit assumption here that the canvas div is the only child element
          // of the root div. If there would be something else, it's gonna be lost.
          var canvas = root.firstChild;
          var canvasHTML = canvas.innerHTML;
          root.innerHTML = canvasHTML;
  
          if ( roots[ rootId ] !== undefined ) {
              delete roots[ rootId ];
              rootsCount--;
          }
          if ( rootsCount === 0 ) {
  
              // In the rare case that more than one impress root elements were initialized, these
              // are only reset when all are uninitialized.
              document.body.classList.remove( "impress-supported" );
              if ( startingState.body.impressNotSupported ) {
                  document.body.classList.add( "impress-not-supported" );
              }
  
              // We need to remove or reset the meta element inserted by impress.js
              var metas = document.head.querySelectorAll( "meta" );
              for ( i = 0; i < metas.length; i++ ) {
                  var m = metas[ i ];
                  if ( m.name === "viewport" ) {
                      if ( startingState.meta !== undefined ) {
                          m.content = startingState.meta;
                      } else {
                          m.parentElement.removeChild( m );
                      }
                  }
              }
          }
  
      };
  
  } )( document, window );
  
  /**
   * Common utility functions
   *
   * Copyright 2011-2012 Bartek Szopka (@bartaz)
   * Henrik Ingo (c) 2016
   * MIT License
   */
  
  ( function( document, window ) {
      "use strict";
      var roots = [];
  
      var libraryFactory = function( rootId ) {
          if ( roots[ rootId ] ) {
              return roots[ rootId ];
          }
  
          // `$` returns first element for given CSS `selector` in the `context` of
          // the given element or whole document.
          var $ = function( selector, context ) {
              context = context || document;
              return context.querySelector( selector );
          };
  
          // `$$` return an array of elements for given CSS `selector` in the `context` of
          // the given element or whole document.
          var $$ = function( selector, context ) {
              context = context || document;
              return arrayify( context.querySelectorAll( selector ) );
          };
  
          // `arrayify` takes an array-like object and turns it into real Array
          // to make all the Array.prototype goodness available.
          var arrayify = function( a ) {
              return [].slice.call( a );
          };
  
          // `byId` returns element with given `id` - you probably have guessed that ;)
          var byId = function( id ) {
              return document.getElementById( id );
          };
  
          // `getElementFromHash` returns an element located by id from hash part of
          // window location.
          var getElementFromHash = function() {
  
              // Get id from url # by removing `#` or `#/` from the beginning,
              // so both "fallback" `#slide-id` and "enhanced" `#/slide-id` will work
              return byId( window.location.hash.replace( /^#\/?/, "" ) );
          };
  
          // `getUrlParamValue` return a given URL parameter value if it exists
          // `undefined` if it doesn't exist
          var getUrlParamValue = function( parameter ) {
              var chunk = window.location.search.split( parameter + "=" )[ 1 ];
              var value = chunk && chunk.split( "&" )[ 0 ];
  
              if ( value !== "" ) {
                  return value;
              }
          };
  
          // Throttling function calls, by Remy Sharp
          // http://remysharp.com/2010/07/21/throttling-function-calls/
          var throttle = function( fn, delay ) {
              var timer = null;
              return function() {
                  var context = this, args = arguments;
                  window.clearTimeout( timer );
                  timer = window.setTimeout( function() {
                      fn.apply( context, args );
                  }, delay );
              };
          };
  
          // `toNumber` takes a value given as `numeric` parameter and tries to turn
          // it into a number. If it is not possible it returns 0 (or other value
          // given as `fallback`).
          var toNumber = function( numeric, fallback ) {
              return isNaN( numeric ) ? ( fallback || 0 ) : Number( numeric );
          };
  
          // `triggerEvent` builds a custom DOM event with given `eventName` and `detail` data
          // and triggers it on element given as `el`.
          var triggerEvent = function( el, eventName, detail ) {
              var event = document.createEvent( "CustomEvent" );
              event.initCustomEvent( eventName, true, true, detail );
              el.dispatchEvent( event );
          };
  
          var lib = {
              $: $,
              $$: $$,
              arrayify: arrayify,
              byId: byId,
              getElementFromHash: getElementFromHash,
              throttle: throttle,
              toNumber: toNumber,
              triggerEvent: triggerEvent,
              getUrlParamValue: getUrlParamValue
          };
          roots[ rootId ] = lib;
          return lib;
      };
  
      // Let impress core know about the existence of this library
      window.impress.addLibraryFactory( { util: libraryFactory } );
  
  } )( document, window );
  
  /**
   * Autoplay plugin - Automatically advance slideshow after N seconds
   *
   * Copyright 2016 Henrik Ingo, henrik.ingo@avoinelama.fi
   * Released under the MIT license.
   */
  /* global clearTimeout, setTimeout, document */
  
  ( function( document ) {
      "use strict";
  
      var autoplayDefault = 0;
      var currentStepTimeout = 0;
      var api = null;
      var timeoutHandle = null;
      var root = null;
      var util;
  
      // On impress:init, check whether there is a default setting, as well as
      // handle step-1.
      document.addEventListener( "impress:init", function( event ) {
          util = event.detail.api.lib.util;
  
          // Getting API from event data instead of global impress().init().
          // You don't even need to know what is the id of the root element
          // or anything. `impress:init` event data gives you everything you
          // need to control the presentation that was just initialized.
          api = event.detail.api;
          root = event.target;
  
          // Element attributes starting with "data-", become available under
          // element.dataset. In addition hyphenized words become camelCased.
          var data = root.dataset;
          var autoplay = util.getUrlParamValue( "impress-autoplay" ) || data.autoplay;
  
          if ( autoplay ) {
              autoplayDefault = util.toNumber( autoplay, 0 );
          }
  
          var toolbar = document.querySelector( "#impress-toolbar" );
          if ( toolbar ) {
              addToolbarButton( toolbar );
          }
  
          api.lib.gc.pushCallback( function() {
              clearTimeout( timeoutHandle );
          } );
  
          // Note that right after impress:init event, also impress:stepenter is
          // triggered for the first slide, so that's where code flow continues.
      }, false );
  
      document.addEventListener( "impress:autoplay:pause", function( event ) {
          status = "paused";
          reloadTimeout( event );
      }, false );
  
      document.addEventListener( "impress:autoplay:play", function( event ) {
          status = "playing";
          reloadTimeout( event );
      }, false );
  
      // If default autoplay time was defined in the presentation root, or
      // in this step, set timeout.
      var reloadTimeout = function( event ) {
          var step = event.target;
          currentStepTimeout = util.toNumber( step.dataset.autoplay, autoplayDefault );
          if ( status === "paused" ) {
              setAutoplayTimeout( 0 );
          } else {
              setAutoplayTimeout( currentStepTimeout );
          }
      };
  
      document.addEventListener( "impress:stepenter", function( event ) {
          reloadTimeout( event );
      }, false );
  
      document.addEventListener( "impress:substep:enter", function( event ) {
          reloadTimeout( event );
      }, false );
  
      /**
       * Set timeout after which we move to next() step.
       */
      var setAutoplayTimeout = function( timeout ) {
          if ( timeoutHandle ) {
              clearTimeout( timeoutHandle );
          }
  
          if ( timeout > 0 ) {
              timeoutHandle = setTimeout( function() { api.next(); }, timeout * 1000 );
          }
          setButtonText();
      };
  
      /*** Toolbar plugin integration *******************************************/
      var status = "not clicked";
      var toolbarButton = null;
  
      var makeDomElement = function( html ) {
          var tempDiv = document.createElement( "div" );
          tempDiv.innerHTML = html;
          return tempDiv.firstChild;
      };
  
      var toggleStatus = function() {
          if ( currentStepTimeout > 0 && status !== "paused" ) {
              status = "paused";
          } else {
              status = "playing";
          }
      };
  
      var getButtonText = function() {
          if ( currentStepTimeout > 0 && status !== "paused" ) {
              return "||"; // Pause
          } else {
              return "&#9654;"; // Play
          }
      };
  
      var setButtonText = function() {
          if ( toolbarButton ) {
  
              // Keep button size the same even if label content is changing
              var buttonWidth = toolbarButton.offsetWidth;
              var buttonHeight = toolbarButton.offsetHeight;
              toolbarButton.innerHTML = getButtonText();
              if ( !toolbarButton.style.width ) {
                  toolbarButton.style.width = buttonWidth + "px";
              }
              if ( !toolbarButton.style.height ) {
                  toolbarButton.style.height = buttonHeight + "px";
              }
          }
      };
  
      var addToolbarButton = function( toolbar ) {
          var html = '<button id="impress-autoplay-playpause" ' + // jshint ignore:line
                     'title="Autoplay" class="impress-autoplay">' + // jshint ignore:line
                     getButtonText() + "</button>"; // jshint ignore:line
          toolbarButton = makeDomElement( html );
          toolbarButton.addEventListener( "click", function() {
              toggleStatus();
              if ( status === "playing" ) {
                  if ( autoplayDefault === 0 ) {
                      autoplayDefault = 7;
                  }
                  if ( currentStepTimeout === 0 ) {
                      currentStepTimeout = autoplayDefault;
                  }
                  setAutoplayTimeout( currentStepTimeout );
              } else if ( status === "paused" ) {
                  setAutoplayTimeout( 0 );
              }
          } );
  
          util.triggerEvent( toolbar, "impress:toolbar:appendChild",
                        { group: 10, element: toolbarButton } );
      };
  
  } )( document );
  
  /**
   * Blackout plugin
   *
   * Press b or . to hide all slides, and b or . again to show them.
   * Also navigating to a different slide will show them again (impress:stepleave).
   *
   * Copyright 2014 @Strikeskids
   * Released under the MIT license.
   */
  /* global document */
  
  ( function( document ) {
      "use strict";
  
      var canvas = null;
      var blackedOut = false;
      var util = null;
      var root = null;
      var api = null;
  
      // While waiting for a shared library of utilities, copying these 2 from main impress.js
      var css = function( el, props ) {
          var key, pkey;
          for ( key in props ) {
              if ( props.hasOwnProperty( key ) ) {
                  pkey = pfx( key );
                  if ( pkey !== null ) {
                      el.style[ pkey ] = props[ key ];
                  }
              }
          }
          return el;
      };
  
      var pfx = ( function() {
  
          var style = document.createElement( "dummy" ).style,
              prefixes = "Webkit Moz O ms Khtml".split( " " ),
              memory = {};
  
          return function( prop ) {
              if ( typeof memory[ prop ] === "undefined" ) {
  
                  var ucProp  = prop.charAt( 0 ).toUpperCase() + prop.substr( 1 ),
                      props   = ( prop + " " + prefixes.join( ucProp + " " ) + ucProp ).split( " " );
  
                  memory[ prop ] = null;
                  for ( var i in props ) {
                      if ( style[ props[ i ] ] !== undefined ) {
                          memory[ prop ] = props[ i ];
                          break;
                      }
                  }
  
              }
  
              return memory[ prop ];
          };
  
      } )();
  
      var removeBlackout = function() {
          if ( blackedOut ) {
              css( canvas, {
                  display: "block"
              } );
              blackedOut = false;
              util.triggerEvent( root, "impress:autoplay:play", {} );
          }
      };
  
      var blackout = function() {
          if ( blackedOut ) {
              removeBlackout();
          } else {
              css( canvas, {
                  display: ( blackedOut = !blackedOut ) ? "none" : "block"
              } );
              blackedOut = true;
              util.triggerEvent( root, "impress:autoplay:pause", {} );
          }
      };
  
      // Wait for impress.js to be initialized
      document.addEventListener( "impress:init", function( event ) {
          api = event.detail.api;
          util = api.lib.util;
          root = event.target;
          canvas = root.firstElementChild;
          var gc = api.lib.gc;
          var util = api.lib.util;
  
          gc.addEventListener( document, "keydown", function( event ) {
  
              // Accept b or . -> . is sent by presentation remote controllers
              if ( event.keyCode === 66 || event.keyCode === 190 ) {
                  event.preventDefault();
                  if ( !blackedOut ) {
                      blackout();
                  } else {
                      removeBlackout();
                  }
              }
          }, false );
  
          gc.addEventListener( document, "keyup", function( event ) {
  
              // Accept b or . -> . is sent by presentation remote controllers
              if ( event.keyCode === 66 || event.keyCode === 190 ) {
                  event.preventDefault();
              }
          }, false );
  
      }, false );
  
      document.addEventListener( "impress:stepleave", function() {
          removeBlackout();
      }, false );
  
  } )( document );
  
  
  /**
   * Extras Plugin
   *
   * This plugin performs initialization (like calling mermaid.initialize())
   * for the extras/ plugins if they are loaded into a presentation.
   *
   * See README.md for details.
   *
   * Copyright 2016 Henrik Ingo (@henrikingo)
   * Released under the MIT license.
   */
  /* global markdown, hljs, mermaid, impress, document, window */
  
  ( function( document, window ) {
      "use strict";
  
      var preInit = function() {
          if ( window.markdown ) {
  
              // Unlike the other extras, Markdown.js doesn't by default do anything in
              // particular. We do it ourselves here.
              // In addition, we use "-----" as a delimiter for new slide.
  
              // Query all .markdown elements and translate to HTML
              var markdownDivs = document.querySelectorAll( ".markdown" );
              for ( var idx = 0; idx < markdownDivs.length; idx++ ) {
                var element = markdownDivs[ idx ];
                var dialect = element.dataset.markdownDialect;
  
                var slides = element.textContent.split( /^-----$/m );
                var i = slides.length - 1;
                element.innerHTML = markdown.toHTML( slides[ i ], dialect );
  
                // If there's an id, unset it for last, and all other, elements,
                // and then set it for the first.
                var id = null;
                if ( element.id ) {
                  id = element.id;
                  element.id = "";
                }
                i--;
                while ( i >= 0 ) {
                  var newElement = element.cloneNode( false );
                  newElement.innerHTML = markdown.toHTML( slides[ i ] );
                  element.parentNode.insertBefore( newElement, element );
                  element = newElement;
                  i--;
                }
                if ( id !== null ) {
                  element.id = id;
                }
              }
          } // Markdown
  
          if ( window.hljs ) {
              hljs.initHighlightingOnLoad();
          }
  
          if ( window.mermaid ) {
              mermaid.initialize( { startOnLoad:true } );
          }
      };
  
      // Register the plugin to be called in pre-init phase
      // Note: Markdown.js should run early/first, because it creates new div elements.
      // So add this with a lower-than-default weight.
      impress.addPreInitPlugin( preInit, 1 );
  
  } )( document, window );
  
  
  /**
   * Form support
   *
   * Functionality to better support use of input, textarea, button... elements in a presentation.
   *
   * This plugin does two things:
   *
   * Set stopPropagation on any element that might take text input. This allows users to type, for
   * example, the letter 'P' into a form field, without causing the presenter console to spring up.
   *
   * On impress:stepleave, de-focus any potentially active
   * element. This is to prevent the focus from being left in a form element that is no longer visible
   * in the window, and user therefore typing garbage into the form.
   *
   * TODO: Currently it is not possible to use TAB to navigate between form elements. Impress.js, and
   * in particular the navigation plugin, unfortunately must fully take control of the tab key,
   * otherwise a user could cause the browser to scroll to a link or button that's not on the current
   * step. However, it could be possible to allow tab navigation between form elements, as long as
   * they are on the active step. This is a topic for further study.
   *
   * Copyright 2016 Henrik Ingo
   * MIT License
   */
  /* global document */
  ( function( document ) {
      "use strict";
      var root;
      var api;
  
      document.addEventListener( "impress:init", function( event ) {
          root = event.target;
          api = event.detail.api;
          var gc = api.lib.gc;
  
          var selectors = [ "input", "textarea", "select", "[contenteditable=true]" ];
          for ( var selector of selectors ) {
              var elements = document.querySelectorAll( selector );
              if ( !elements ) {
                  continue;
              }
  
              for ( var i = 0; i < elements.length; i++ ) {
                  var e = elements[ i ];
                  gc.addEventListener( e, "keydown", function( event ) {
                      event.stopPropagation();
                  } );
                  gc.addEventListener( e, "keyup", function( event ) {
                      event.stopPropagation();
                  } );
              }
          }
      }, false );
  
      document.addEventListener( "impress:stepleave", function() {
          document.activeElement.blur();
      }, false );
  
  } )( document );
  
  
  /**
   * Fullscreen plugin
   *
   * Press F5 to enter fullscreen and ESC to exit fullscreen mode.
   *
   * Copyright 2019 @giflw
   * Released under the MIT license.
   */
  /* global document */
  
  ( function( document ) {
      "use strict";
  
      function enterFullscreen() {
          var elem = document.documentElement;
          if ( !document.fullscreenElement ) {
              elem.requestFullscreen();
          }
      }
  
      function exitFullscreen() {
          if ( document.fullscreenElement ) {
              document.exitFullscreen();
          }
      }
  
      // Wait for impress.js to be initialized
      document.addEventListener( "impress:init", function( event ) {
          var api = event.detail.api;
          var root = event.target;
          var gc = api.lib.gc;
          var util = api.lib.util;
  
          gc.addEventListener( document, "keydown", function( event ) {
  
              // 116 (F5) is sent by presentation remote controllers
              if ( event.code === "F5" ) {
                  event.preventDefault();
                  enterFullscreen();
                  util.triggerEvent( root.querySelector( ".active" ), "impress:steprefresh" );
              }
  
              // 27 (Escape) is sent by presentation remote controllers
              if ( event.key === "Escape" || event.key === "F5" ) {
                  event.preventDefault();
                  exitFullscreen();
                  util.triggerEvent( root.querySelector( ".active" ), "impress:steprefresh" );
              }
          }, false );
  
          util.triggerEvent( document, "impress:help:add",
              { command: "F5 / ESC", text: "Fullscreen: Enter / Exit", row: 200 } );
  
      }, false );
  
  } )( document );
  
  
  /**
   * Goto Plugin
   *
   * The goto plugin is a pre-stepleave plugin. It is executed before impress:stepleave,
   * and will alter the destination where to transition next.
   *
   * Example:
   *
   *         <!-- When leaving this step, go directly to "step-5" -->
   *         <div class="step" data-goto="step-5">
   *
   *         <!-- When leaving this step with next(), go directly to "step-5", instead of next step.
   *              If moving backwards to previous step - e.g. prev() instead of next() -
   *              then go to "step-1". -->
   *         <div class="step" data-goto-next="step-5" data-goto-prev="step-1">
   *
   *        <!-- data-goto-key-list and data-goto-next-list allow you to build advanced non-linear
   *             navigation. -->
   *        <div class="step"
   *             data-goto-key-list="ArrowUp ArrowDown ArrowRight ArrowLeft"
   *             data-goto-next-list="step-4 step-3 step-2 step-5">
   *
   * See https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/key/Key_Values for a table
   * of what strings to use for each key.
   *
   * Copyright 2016-2017 Henrik Ingo (@henrikingo)
   * Released under the MIT license.
   */
  /* global window, document, impress */
  
  ( function( document, window ) {
      "use strict";
      var lib;
  
      document.addEventListener( "impress:init", function( event ) {
          lib = event.detail.api.lib;
      }, false );
  
      var isNumber = function( numeric ) {
          return !isNaN( numeric );
      };
  
      var goto = function( event ) {
          if ( ( !event ) || ( !event.target ) ) {
              return;
          }
  
          var data = event.target.dataset;
          var steps = document.querySelectorAll( ".step" );
  
          // Data-goto-key-list="" & data-goto-next-list="" //////////////////////////////////////////
          if ( data.gotoKeyList !== undefined &&
               data.gotoNextList !== undefined &&
               event.origEvent !== undefined &&
               event.origEvent.key !== undefined ) {
              var keylist = data.gotoKeyList.split( " " );
              var nextlist = data.gotoNextList.split( " " );
  
              if ( keylist.length !== nextlist.length ) {
                  window.console.log(
                      "impress goto plugin: data-goto-key-list and data-goto-next-list don't match:"
                  );
                  window.console.log( keylist );
                  window.console.log( nextlist );
  
                  // Don't return, allow the other categories to work despite this error
              } else {
                  var index = keylist.indexOf( event.origEvent.key );
                  if ( index >= 0 ) {
                      var next = nextlist[ index ];
                      if ( isNumber( next ) ) {
                          event.detail.next = steps[ next ];
  
                          // If the new next element has its own transitionDuration, we're responsible
                          // for setting that on the event as well
                          event.detail.transitionDuration = lib.util.toNumber(
                              event.detail.next.dataset.transitionDuration,
                              event.detail.transitionDuration
                          );
                          return;
                      } else {
                          var newTarget = document.getElementById( next );
                          if ( newTarget && newTarget.classList.contains( "step" ) ) {
                              event.detail.next = newTarget;
                              event.detail.transitionDuration = lib.util.toNumber(
                                  event.detail.next.dataset.transitionDuration,
                                  event.detail.transitionDuration
                              );
                              return;
                          } else {
                              window.console.log( "impress goto plugin: " + next +
                                                  " is not a step in this impress presentation." );
                          }
                      }
                  }
              }
          }
  
          // Data-goto-next="" & data-goto-prev="" ///////////////////////////////////////////////////
  
          // Handle event.target data-goto-next attribute
          if ( isNumber( data.gotoNext ) && event.detail.reason === "next" ) {
              event.detail.next = steps[ data.gotoNext ];
  
              // If the new next element has its own transitionDuration, we're responsible for setting
              // that on the event as well
              event.detail.transitionDuration = lib.util.toNumber(
                  event.detail.next.dataset.transitionDuration, event.detail.transitionDuration
              );
              return;
          }
          if ( data.gotoNext && event.detail.reason === "next" ) {
              var newTarget = document.getElementById( data.gotoNext ); // jshint ignore:line
              if ( newTarget && newTarget.classList.contains( "step" ) ) {
                  event.detail.next = newTarget;
                  event.detail.transitionDuration = lib.util.toNumber(
                      event.detail.next.dataset.transitionDuration,
                      event.detail.transitionDuration
                  );
                  return;
              } else {
                  window.console.log( "impress goto plugin: " + data.gotoNext +
                                      " is not a step in this impress presentation." );
              }
          }
  
          // Handle event.target data-goto-prev attribute
          if ( isNumber( data.gotoPrev ) && event.detail.reason === "prev" ) {
              event.detail.next = steps[ data.gotoPrev ];
              event.detail.transitionDuration = lib.util.toNumber(
                  event.detail.next.dataset.transitionDuration, event.detail.transitionDuration
              );
              return;
          }
          if ( data.gotoPrev && event.detail.reason === "prev" ) {
              var newTarget = document.getElementById( data.gotoPrev ); // jshint ignore:line
              if ( newTarget && newTarget.classList.contains( "step" ) ) {
                  event.detail.next = newTarget;
                  event.detail.transitionDuration = lib.util.toNumber(
                      event.detail.next.dataset.transitionDuration, event.detail.transitionDuration
                  );
                  return;
              } else {
                  window.console.log( "impress goto plugin: " + data.gotoPrev +
                                      " is not a step in this impress presentation." );
              }
          }
  
          // Data-goto="" ///////////////////////////////////////////////////////////////////////////
  
          // Handle event.target data-goto attribute
          if ( isNumber( data.goto ) ) {
              event.detail.next = steps[ data.goto ];
              event.detail.transitionDuration = lib.util.toNumber(
                  event.detail.next.dataset.transitionDuration, event.detail.transitionDuration
              );
              return;
          }
          if ( data.goto ) {
              var newTarget = document.getElementById( data.goto ); // jshint ignore:line
              if ( newTarget && newTarget.classList.contains( "step" ) ) {
                  event.detail.next = newTarget;
                  event.detail.transitionDuration = lib.util.toNumber(
                      event.detail.next.dataset.transitionDuration, event.detail.transitionDuration
                  );
                  return;
              } else {
                  window.console.log( "impress goto plugin: " + data.goto +
                                      " is not a step in this impress presentation." );
              }
          }
      };
  
      // Register the plugin to be called in pre-stepleave phase
      impress.addPreStepLeavePlugin( goto );
  
  } )( document, window );
  
  
  /**
   * Help popup plugin
   *
   * Example:
   *
   *     <!-- Show a help popup at start, or if user presses "H" -->
   *     <div id="impress-help"></div>
   *
   * For developers:
   *
   * Typical use for this plugin, is for plugins that support some keypress, to add a line
   * to the help popup produced by this plugin. For example "P: Presenter console".
   *
   * Copyright 2016 Henrik Ingo (@henrikingo)
   * Released under the MIT license.
   */
  /* global window, document */
  
  ( function( document, window ) {
      "use strict";
      var rows = [];
      var timeoutHandle;
  
      var triggerEvent = function( el, eventName, detail ) {
          var event = document.createEvent( "CustomEvent" );
          event.initCustomEvent( eventName, true, true, detail );
          el.dispatchEvent( event );
      };
  
      var renderHelpDiv = function() {
          var helpDiv = document.getElementById( "impress-help" );
          if ( helpDiv ) {
              var html = [];
              for ( var row in rows ) {
                  for ( var arrayItem in row ) {
                      html.push( rows[ row ][ arrayItem ] );
                  }
              }
              if ( html ) {
                  helpDiv.innerHTML = "<table>\n" + html.join( "\n" ) + "</table>\n";
              }
          }
      };
  
      var toggleHelp = function() {
          var helpDiv = document.getElementById( "impress-help" );
          if ( !helpDiv ) {
              return;
          }
  
          if ( helpDiv.style.display === "block" ) {
              helpDiv.style.display = "none";
          } else {
              helpDiv.style.display = "block";
              window.clearTimeout( timeoutHandle );
          }
      };
  
      document.addEventListener( "keyup", function( event ) {
  
          if ( event.keyCode === 72 || event.keyCode === 191 ) { // "h" || "?"
              event.preventDefault();
              toggleHelp();
          }
      }, false );
  
      // API
      // Other plugins can add help texts, typically if they support an action on a keypress.
      /**
       * Add a help text to the help popup.
       *
       * :param: e.detail.command  Example: "H"
       * :param: e.detail.text     Example: "Show this help."
       * :param: e.detail.row      Row index from 0 to 9 where to place this help text. Example: 0
       */
      document.addEventListener( "impress:help:add", function( e ) {
  
          // The idea is for the sender of the event to supply a unique row index, used for sorting.
          // But just in case two plugins would ever use the same row index, we wrap each row into
          // its own array. If there are more than one entry for the same index, they are shown in
          // first come, first serve ordering.
          var rowIndex = e.detail.row;
          if ( typeof rows[ rowIndex ] !== "object" || !rows[ rowIndex ].isArray ) {
              rows[ rowIndex ] = [];
          }
          rows[ e.detail.row ].push( "<tr><td><strong>" + e.detail.command + "</strong></td><td>" +
                                     e.detail.text + "</td></tr>" );
          renderHelpDiv();
      } );
  
      document.addEventListener( "impress:init", function( e ) {
          renderHelpDiv();
  
          // At start, show the help for 7 seconds.
          var helpDiv = document.getElementById( "impress-help" );
          if ( helpDiv ) {
              helpDiv.style.display = "block";
              timeoutHandle = window.setTimeout( function() {
                  var helpDiv = document.getElementById( "impress-help" );
                  helpDiv.style.display = "none";
              }, 7000 );
  
              // Regster callback to empty the help div on teardown
              var api = e.detail.api;
              api.lib.gc.pushCallback( function() {
                  window.clearTimeout( timeoutHandle );
                  helpDiv.style.display = "";
                  helpDiv.innerHTML = "";
                  rows = [];
              } );
          }
  
          // Use our own API to register the help text for "h"
          triggerEvent( document, "impress:help:add",
                        { command: "H", text: "Show this help", row: 0 } );
      } );
  
  } )( document, window );
  
  
  /**
   * Adds a presenter console to impress.js
   *
   * MIT Licensed, see license.txt.
   *
   * Copyright 2012, 2013, 2015 impress-console contributors (see README.txt)
   *
   * version: 1.3-dev
   *
   */
  
  // This file contains so much HTML, that we will just respectfully disagree about js
  /* jshint quotmark:single */
  /* global navigator, top, setInterval, clearInterval, document, window */
  
  ( function( document, window ) {
      'use strict';
  
      // TODO: Move this to src/lib/util.js
      var triggerEvent = function( el, eventName, detail ) {
          var event = document.createEvent( 'CustomEvent' );
          event.initCustomEvent( eventName, true, true, detail );
          el.dispatchEvent( event );
      };
  
      // Create Language object depending on browsers language setting
      var lang;
      switch ( navigator.language ) {
      case 'de':
          lang = {
              'noNotes': '<div class="noNotes">Keine Notizen hierzu</div>',
              'restart': 'Neustart',
              'clickToOpen': 'Klicken um Sprecherkonsole zu öffnen',
              'prev': 'zurück',
              'next': 'weiter',
              'loading': 'initalisiere',
              'ready': 'Bereit',
              'moving': 'in Bewegung',
              'useAMPM': false
          };
          break;
      case 'en': // jshint ignore:line
      default : // jshint ignore:line
          lang = {
              'noNotes': '<div class="noNotes">No notes for this step</div>',
              'restart': 'Restart',
              'clickToOpen': 'Click to open speaker console',
              'prev': 'Prev',
              'next': 'Next',
              'loading': 'Loading',
              'ready': 'Ready',
              'moving': 'Moving',
              'useAMPM': false
          };
          break;
      }
  
      // Settings to set iframe in speaker console
      const preViewDefaultFactor = 0.7;
      const preViewMinimumFactor = 0.5;
      const preViewGap    = 4;
  
      // This is the default template for the speaker console window
      const consoleTemplate = '<!DOCTYPE html>' +
          '<html id="impressconsole"><head>' +
  
            // Order is important: If user provides a cssFile, those will win, because they're later
            '{{cssStyle}}' +
            '{{cssLink}}' +
          '</head><body>' +
          '<div id="console">' +
            '<div id="views">' +
              '<iframe id="slideView" scrolling="no"></iframe>' +
              '<iframe id="preView" scrolling="no"></iframe>' +
              '<div id="blocker"></div>' +
            '</div>' +
            '<div id="notes"></div>' +
          '</div>' +
          '<div id="controls"> ' +
            '<div id="prev"><a  href="#" onclick="impress().prev(); return false;" />' +
              '{{prev}}</a></div>' +
            '<div id="next"><a  href="#" onclick="impress().next(); return false;" />' +
              '{{next}}</a></div>' +
            '<div id="clock">--:--</div>' +
            '<div id="timer" onclick="timerReset()">00m 00s</div>' +
            '<div id="status">{{loading}}</div>' +
          '</div>' +
          '</body></html>';
  
      // Default css location
      var cssFileOldDefault = 'css/impressConsole.css';
      var cssFile = undefined; // jshint ignore:line
  
      // Css for styling iframs on the console
      var cssFileIframeOldDefault = 'css/iframe.css';
      var cssFileIframe = undefined; // jshint ignore:line
  
      // All console windows, so that you can call impressConsole() repeatedly.
      var allConsoles = {};
  
      // Zero padding helper function:
      var zeroPad = function( i ) {
          return ( i < 10 ? '0' : '' ) + i;
      };
  
      // The console object
      var impressConsole = window.impressConsole = function( rootId ) {
  
          rootId = rootId || 'impress';
  
          if ( allConsoles[ rootId ] ) {
              return allConsoles[ rootId ];
          }
  
          // Root presentation elements
          var root = document.getElementById( rootId );
  
          var consoleWindow = null;
  
          var nextStep = function() {
              var classes = '';
              var nextElement = document.querySelector( '.active' );
  
              // Return to parents as long as there is no next sibling
              while ( !nextElement.nextElementSibling && nextElement.parentNode ) {
                  nextElement = nextElement.parentNode;
              }
              nextElement = nextElement.nextElementSibling;
              while ( nextElement ) {
                  classes = nextElement.attributes[ 'class' ];
                  if ( classes && classes.value.indexOf( 'step' ) !== -1 ) {
                      consoleWindow.document.getElementById( 'blocker' ).innerHTML = lang.next;
                      return nextElement;
                  }
  
                  if ( nextElement.firstElementChild ) { // First go into deep
                      nextElement = nextElement.firstElementChild;
                  } else {
  
                      // Go to next sibling or through parents until there is a next sibling
                      while ( !nextElement.nextElementSibling && nextElement.parentNode ) {
                          nextElement = nextElement.parentNode;
                      }
                      nextElement = nextElement.nextElementSibling;
                  }
              }
  
              // No next element. Pick the first
              consoleWindow.document.getElementById( 'blocker' ).innerHTML = lang.restart;
              return document.querySelector( '.step' );
          };
  
          // Sync the notes to the step
          var onStepLeave = function() {
              if ( consoleWindow ) {
  
                  // Set notes to next steps notes.
                  var newNotes = document.querySelector( '.active' ).querySelector( '.notes' );
                  if ( newNotes ) {
                      newNotes = newNotes.innerHTML;
                  } else {
                      newNotes = lang.noNotes;
                  }
                  consoleWindow.document.getElementById( 'notes' ).innerHTML = newNotes;
  
                  // Set the views
                  var baseURL = document.URL.substring( 0, document.URL.search( '#/' ) );
                  var slideSrc = baseURL + '#' + document.querySelector( '.active' ).id;
                  var preSrc = baseURL + '#' + nextStep().id;
                  var slideView = consoleWindow.document.getElementById( 'slideView' );
  
                  // Setting when already set causes glitches in Firefox, so check first:
                  if ( slideView.src !== slideSrc ) {
                      slideView.src = slideSrc;
                  }
                  var preView = consoleWindow.document.getElementById( 'preView' );
                  if ( preView.src !== preSrc ) {
                      preView.src = preSrc;
                  }
  
                  consoleWindow.document.getElementById( 'status' ).innerHTML =
                      '<span class="moving">' + lang.moving + '</span>';
              }
          };
  
          // Sync the previews to the step
          var onStepEnter = function() {
              if ( consoleWindow ) {
  
                  // We do everything here again, because if you stopped the previos step to
                  // early, the onstepleave trigger is not called for that step, so
                  // we need this to sync things.
                  var newNotes = document.querySelector( '.active' ).querySelector( '.notes' );
                  if ( newNotes ) {
                      newNotes = newNotes.innerHTML;
                  } else {
                      newNotes = lang.noNotes;
                  }
                  var notes = consoleWindow.document.getElementById( 'notes' );
                  notes.innerHTML = newNotes;
                  notes.scrollTop = 0;
  
                  // Set the views
                  var baseURL = document.URL.substring( 0, document.URL.search( '#/' ) );
                  var slideSrc = baseURL + '#' + document.querySelector( '.active' ).id;
                  var preSrc = baseURL + '#' + nextStep().id;
                  var slideView = consoleWindow.document.getElementById( 'slideView' );
  
                  // Setting when already set causes glitches in Firefox, so check first:
                  if ( slideView.src !== slideSrc ) {
                      slideView.src = slideSrc;
                  }
                  var preView = consoleWindow.document.getElementById( 'preView' );
                  if ( preView.src !== preSrc ) {
                      preView.src = preSrc;
                  }
  
                  consoleWindow.document.getElementById( 'status' ).innerHTML =
                      '<span  class="ready">' + lang.ready + '</span>';
              }
          };
  
          // Sync substeps
          var onSubstep = function( event ) {
              if ( consoleWindow ) {
                  if ( event.detail.reason === 'next' ) {
                      onSubstepShow();
                  }
                  if ( event.detail.reason === 'prev' ) {
                      onSubstepHide();
                  }
              }
          };
  
          var onSubstepShow = function() {
              var slideView = consoleWindow.document.getElementById( 'slideView' );
              triggerEventInView( slideView, 'impress:substep:show' );
          };
  
          var onSubstepHide = function() {
              var slideView = consoleWindow.document.getElementById( 'slideView' );
              triggerEventInView( slideView, 'impress:substep:hide' );
          };
  
          var triggerEventInView = function( frame, eventName, detail ) {
  
              // Note: Unfortunately Chrome does not allow createEvent on file:// URLs, so this won't
              // work. This does work on Firefox, and should work if viewing the presentation on a
              // http:// URL on Chrome.
              var event = frame.contentDocument.createEvent( 'CustomEvent' );
              event.initCustomEvent( eventName, true, true, detail );
              frame.contentDocument.dispatchEvent( event );
          };
  
          var spaceHandler = function() {
              var notes = consoleWindow.document.getElementById( 'notes' );
              if ( notes.scrollTopMax - notes.scrollTop > 20 ) {
                 notes.scrollTop = notes.scrollTop + notes.clientHeight * 0.8;
              } else {
                 window.impress().next();
              }
          };
  
          var timerReset = function() {
              consoleWindow.timerStart = new Date();
          };
  
          // Show a clock
          var clockTick = function() {
              var now = new Date();
              var hours = now.getHours();
              var minutes = now.getMinutes();
              var seconds = now.getSeconds();
              var ampm = '';
  
              if ( lang.useAMPM ) {
                  ampm = ( hours < 12 ) ? 'AM' : 'PM';
                  hours = ( hours > 12 ) ? hours - 12 : hours;
                  hours = ( hours === 0 ) ? 12 : hours;
              }
  
              // Clock
              var clockStr = zeroPad( hours ) + ':' + zeroPad( minutes ) + ':' + zeroPad( seconds ) +
                             ' ' + ampm;
              consoleWindow.document.getElementById( 'clock' ).firstChild.nodeValue = clockStr;
  
              // Timer
              seconds = Math.floor( ( now - consoleWindow.timerStart ) / 1000 );
              minutes = Math.floor( seconds / 60 );
              seconds = Math.floor( seconds % 60 );
              consoleWindow.document.getElementById( 'timer' ).firstChild.nodeValue =
                  zeroPad( minutes ) + 'm ' + zeroPad( seconds ) + 's';
  
              if ( !consoleWindow.initialized ) {
  
                  // Nudge the slide windows after load, or they will scrolled wrong on Firefox.
                  consoleWindow.document.getElementById( 'slideView' ).contentWindow.scrollTo( 0, 0 );
                  consoleWindow.document.getElementById( 'preView' ).contentWindow.scrollTo( 0, 0 );
                  consoleWindow.initialized = true;
              }
          };
  
          var registerKeyEvent = function( keyCodes, handler, window ) {
              if ( window === undefined ) {
                  window = consoleWindow;
              }
  
              // Prevent default keydown action when one of supported key is pressed
              window.document.addEventListener( 'keydown', function( event ) {
                  if ( !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey &&
                       keyCodes.indexOf( event.keyCode ) !== -1 ) {
                      event.preventDefault();
                  }
              }, false );
  
              // Trigger impress action on keyup
              window.document.addEventListener( 'keyup', function( event ) {
                  if ( !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey &&
                       keyCodes.indexOf( event.keyCode ) !== -1 ) {
                          handler();
                          event.preventDefault();
                  }
              }, false );
          };
  
          var consoleOnLoad = function() {
                  var slideView = consoleWindow.document.getElementById( 'slideView' );
                  var preView = consoleWindow.document.getElementById( 'preView' );
  
                  // Firefox:
                  slideView.contentDocument.body.classList.add( 'impress-console' );
                  preView.contentDocument.body.classList.add( 'impress-console' );
                  if ( cssFileIframe !== undefined ) {
                      slideView.contentDocument.head.insertAdjacentHTML(
                          'beforeend',
                          '<link rel="stylesheet" type="text/css" href="' + cssFileIframe + '">'
                      );
                      preView.contentDocument.head.insertAdjacentHTML(
                          'beforeend',
                          '<link rel="stylesheet" type="text/css" href="' + cssFileIframe + '">'
                      );
                  }
  
                  // Chrome:
                  slideView.addEventListener( 'load', function() {
                          slideView.contentDocument.body.classList.add( 'impress-console' );
                          if ( cssFileIframe !== undefined ) {
                              slideView.contentDocument.head.insertAdjacentHTML(
                                  'beforeend',
                                  '<link rel="stylesheet" type="text/css" href="' +
                                      cssFileIframe + '">'
                              );
                          }
                  } );
                  preView.addEventListener( 'load', function() {
                          preView.contentDocument.body.classList.add( 'impress-console' );
                          if ( cssFileIframe !== undefined ) {
                              preView.contentDocument.head.insertAdjacentHTML(
                                  'beforeend',
                                  '<link rel="stylesheet" type="text/css" href="' +
                                      cssFileIframe + '">' );
                          }
                  } );
          };
  
          var open = function() {
              if ( top.isconsoleWindow ) {
                  return;
              }
  
              if ( consoleWindow && !consoleWindow.closed ) {
                  consoleWindow.focus();
              } else {
                  consoleWindow = window.open( '', 'impressConsole' );
  
                  // If opening failes this may be because the browser prevents this from
                  // not (or less) interactive JavaScript...
                  if ( consoleWindow == null ) {
  
                      // ... so I add a button to klick.
                      // workaround on firefox
                      var message = document.createElement( 'div' );
                      message.id = 'impress-console-button';
                      message.style.position = 'fixed';
                      message.style.left = 0;
                      message.style.top = 0;
                      message.style.right = 0;
                      message.style.bottom = 0;
                      message.style.backgroundColor = 'rgba(255, 255, 255, 0.9)';
                      var clickStr = 'var x = document.getElementById(\'impress-console-button\');' +
                                       'x.parentNode.removeChild(x);' +
                                       'var r = document.getElementById(\'' + rootId + '\');' +
                                       'impress(\'' + rootId +
                                       '\').lib.util.triggerEvent(r, \'impress:console:open\', {})';
                      var styleStr = 'margin: 25vh 25vw;width:50vw;height:50vh;';
                      message.innerHTML = '<button style="' + styleStr + '" ' +
                                                   'onclick="' + clickStr + '">' +
                                          lang.clickToOpen +
                                          '</button>';
                      document.body.appendChild( message );
                      return;
                  }
  
                  var cssLink = '';
                  if ( cssFile !== undefined ) {
                      cssLink = '<link rel="stylesheet" type="text/css" media="screen" href="' +
                                cssFile + '">';
                  }
  
                  // This sets the window location to the main window location, so css can be loaded:
                  consoleWindow.document.open();
  
                  // Write the template:
                  consoleWindow.document.write(
  
                      // CssStyleStr is lots of inline <style></style> defined at the end of this file
                      consoleTemplate.replace( '{{cssStyle}}', cssStyleStr() )
                                     .replace( '{{cssLink}}', cssLink )
                                     .replace( /{{.*?}}/gi, function( x ) {
                                         return lang[ x.substring( 2, x.length - 2 ) ]; }
                                     )
                  );
                  consoleWindow.document.title = 'Speaker Console (' + document.title + ')';
                  consoleWindow.impress = window.impress;
  
                  // We set this flag so we can detect it later, to prevent infinite popups.
                  consoleWindow.isconsoleWindow = true;
  
                  // Set the onload function:
                  consoleWindow.onload = consoleOnLoad;
  
                  // Add clock tick
                  consoleWindow.timerStart = new Date();
                  consoleWindow.timerReset = timerReset;
                  consoleWindow.clockInterval = setInterval( allConsoles[ rootId ].clockTick, 1000 );
  
                  // Keyboard navigation handlers
                  // 33: pg up, 37: left, 38: up
                  registerKeyEvent( [ 33, 37, 38 ], window.impress().prev );
  
                  // 34: pg down, 39: right, 40: down
                  registerKeyEvent( [ 34, 39, 40 ], window.impress().next );
  
                  // 32: space
                  registerKeyEvent( [ 32 ], spaceHandler );
  
                  // 82: R
                  registerKeyEvent( [ 82 ], timerReset );
  
                  // Cleanup
                  consoleWindow.onbeforeunload = function() {
  
                      // I don't know why onunload doesn't work here.
                      clearInterval( consoleWindow.clockInterval );
                  };
  
                  // It will need a little nudge on Firefox, but only after loading:
                  onStepEnter();
                  consoleWindow.initialized = false;
                  consoleWindow.document.close();
  
                  //Catch any window resize to pass size on
                  window.onresize = resize;
                  consoleWindow.onresize = resize;
  
                  return consoleWindow;
              }
          };
  
          var resize = function() {
              var slideView = consoleWindow.document.getElementById( 'slideView' );
              var preView = consoleWindow.document.getElementById( 'preView' );
  
              // Get ratio of presentation
              var ratio = window.innerHeight / window.innerWidth;
  
              // Get size available for views
              var views = consoleWindow.document.getElementById( 'views' );
  
              // SlideView may have a border or some padding:
              // asuming same border width on both direktions
              var delta = slideView.offsetWidth - slideView.clientWidth;
  
              // Set views
              var slideViewWidth = ( views.clientWidth - delta );
              var slideViewHeight = Math.floor( slideViewWidth * ratio );
  
              var preViewTop = slideViewHeight + preViewGap;
  
              var preViewWidth = Math.floor( slideViewWidth * preViewDefaultFactor );
              var preViewHeight = Math.floor( slideViewHeight * preViewDefaultFactor );
  
              // Shrink preview to fit into space available
              if ( views.clientHeight - delta < preViewTop + preViewHeight ) {
                  preViewHeight = views.clientHeight - delta - preViewTop;
                  preViewWidth = Math.floor( preViewHeight / ratio );
              }
  
              // If preview is not high enough forget ratios!
              if ( preViewWidth <= Math.floor( slideViewWidth * preViewMinimumFactor ) ) {
                  slideViewWidth = ( views.clientWidth - delta );
                  slideViewHeight = Math.floor( ( views.clientHeight - delta - preViewGap ) /
                                               ( 1 + preViewMinimumFactor ) );
  
                  preViewTop = slideViewHeight + preViewGap;
  
                  preViewWidth = Math.floor( slideViewWidth * preViewMinimumFactor );
                  preViewHeight = views.clientHeight - delta - preViewTop;
              }
  
              // Set the calculated into styles
              slideView.style.width = slideViewWidth + 'px';
              slideView.style.height = slideViewHeight + 'px';
  
              preView.style.top = preViewTop + 'px';
  
              preView.style.width = preViewWidth + 'px';
              preView.style.height = preViewHeight + 'px';
          };
  
          var _init = function( cssConsole, cssIframe ) {
              if ( cssConsole !== undefined ) {
                  cssFile = cssConsole;
              }
  
              // You can also specify the css in the presentation root div:
              // <div id="impress" data-console-css=..." data-console-css-iframe="...">
              else if ( root.dataset.consoleCss !== undefined ) {
                  cssFile = root.dataset.consoleCss;
              }
  
              if ( cssIframe !== undefined ) {
                  cssFileIframe = cssIframe;
              } else if ( root.dataset.consoleCssIframe !== undefined ) {
                  cssFileIframe = root.dataset.consoleCssIframe;
              }
  
              // Register the event
              root.addEventListener( 'impress:stepleave', onStepLeave );
              root.addEventListener( 'impress:stepenter', onStepEnter );
              root.addEventListener( 'impress:substep:stepleaveaborted', onSubstep );
              root.addEventListener( 'impress:substep:show', onSubstepShow );
              root.addEventListener( 'impress:substep:hide', onSubstepHide );
  
              //When the window closes, clean up after ourselves.
              window.onunload = function() {
                  if ( consoleWindow && !consoleWindow.closed ) {
                      consoleWindow.close();
                  }
              };
  
              //Open speaker console when they press 'p'
              registerKeyEvent( [ 80 ], open, window );
  
              //Btw, you can also launch console automatically:
              //<div id="impress" data-console-autolaunch="true">
              if ( root.dataset.consoleAutolaunch === 'true' ) {
                  open();
              }
          };
  
          var init = function( cssConsole, cssIframe ) {
              if ( ( cssConsole === undefined || cssConsole === cssFileOldDefault ) &&
                   ( cssIframe === undefined  || cssIframe === cssFileIframeOldDefault ) ) {
                  window.console.log( 'impressConsole().init() is deprecated. ' +
                                     'impressConsole is now initialized automatically when you ' +
                                     'call impress().init().' );
              }
              _init( cssConsole, cssIframe );
          };
  
          // New API for impress.js plugins is based on using events
          root.addEventListener( 'impress:console:open', function() {
              open();
          } );
  
          /**
           * Register a key code to an event handler
           *
           * :param: event.detail.keyCodes    List of key codes
           * :param: event.detail.handler     A function registered as the event handler
           * :param: event.detail.window      The console window to register the keycode in
           */
          root.addEventListener( 'impress:console:registerKeyEvent', function( event ) {
              registerKeyEvent( event.detail.keyCodes, event.detail.handler, event.detail.window );
          } );
  
          // Return the object
          allConsoles[ rootId ] = { init: init, open: open, clockTick: clockTick,
                                 registerKeyEvent: registerKeyEvent, _init: _init };
          return allConsoles[ rootId ];
  
      };
  
      // This initializes impressConsole automatically when initializing impress itself
      document.addEventListener( 'impress:init', function( event ) {
  
          // Note: impressConsole wants the id string, not the DOM element directly
          impressConsole( event.target.id )._init();
  
          // Add 'P' to the help popup
          triggerEvent( document, 'impress:help:add',
                          { command: 'P', text: 'Presenter console', row: 10 } );
      } );
  
      // Returns a string to be used inline as a css <style> element in the console window.
      // Apologies for length, but hiding it here at the end to keep it away from rest of the code.
      var cssStyleStr = function() {
          return `<style>
              #impressconsole body {
                  background-color: rgb(255, 255, 255);
                  padding: 0;
                  margin: 0;
                  font-family: verdana, arial, sans-serif;
                  font-size: 2vw;
              }
              #impressconsole div#console {
                  position: absolute;
                  top: 0.5vw;
                  left: 0.5vw;
                  right: 0.5vw;
                  bottom: 3vw;
                  margin: 0;
              }
              #impressconsole div#views, #impressconsole div#notes {
                  position: absolute;
                  top: 0;
                  bottom: 0;
              }
              #impressconsole div#views {
                  left: 0;
                  right: 50vw;
                  overflow: hidden;
              }
              #impressconsole div#blocker {
                  position: absolute;
                  right: 0;
                  bottom: 0;
              }
              #impressconsole div#notes {
                  left: 50vw;
                  right: 0;
                  overflow-x: hidden;
                  overflow-y: auto;
                  padding: 0.3ex;
                  background-color: rgb(255, 255, 255);
                  border: solid 1px rgb(120, 120, 120);
              }
              #impressconsole div#notes .noNotes {
                  color: rgb(200, 200, 200);
              }
              #impressconsole div#notes p {
                  margin-top: 0;
              }
              #impressconsole iframe {
                  position: absolute;
                  margin: 0;
                  padding: 0;
                  left: 0;
                  border: solid 1px rgb(120, 120, 120);
              }
              #impressconsole iframe#slideView {
                  top: 0;
                  width: 49vw;
                  height: 49vh;
              }
              #impressconsole iframe#preView {
                  opacity: 0.7;
                  top: 50vh;
                  width: 30vw;
                  height: 30vh;
              }
              #impressconsole div#controls {
                  margin: 0;
                  position: absolute;
                  bottom: 0.25vw;
                  left: 0.5vw;
                  right: 0.5vw;
                  height: 2.5vw;
                  background-color: rgb(255, 255, 255);
                  background-color: rgba(255, 255, 255, 0.6);
              }
              #impressconsole div#prev, div#next {
              }
              #impressconsole div#prev a, #impressconsole div#next a {
                  display: block;
                  border: solid 1px rgb(70, 70, 70);
                  border-radius: 0.5vw;
                  font-size: 1.5vw;
                  padding: 0.25vw;
                  text-decoration: none;
                  background-color: rgb(220, 220, 220);
                  color: rgb(0, 0, 0);
              }
              #impressconsole div#prev a:hover, #impressconsole div#next a:hover {
                  background-color: rgb(245, 245, 245);
              }
              #impressconsole div#prev {
                  float: left;
              }
              #impressconsole div#next {
                  float: right;
              }
              #impressconsole div#status {
                  margin-left: 2em;
                  margin-right: 2em;
                  text-align: center;
                  float: right;
              }
              #impressconsole div#clock {
                  margin-left: 2em;
                  margin-right: 2em;
                  text-align: center;
                  float: left;
              }
              #impressconsole div#timer {
                  margin-left: 2em;
                  margin-right: 2em;
                  text-align: center;
                  float: left;
              }
              #impressconsole span.moving {
                  color: rgb(255, 0, 0);
              }
              #impressconsole span.ready {
                  color: rgb(0, 128, 0);
              }
          </style>`;
      };
  
  } )( document, window );
  
  /**
   * Media Plugin
   *
   * This plugin will do the following things:
   *
   *  - Add a special class when playing (body.impress-media-video-playing
   *    and body.impress-media-video-playing) and pausing media (body.impress-media-video-paused
   *    and body.impress-media-audio-paused) (removing them when ending).
   *    This can be useful for example for darkening the background or fading out other elements
   *    while a video is playing.
   *    Only media at the current step are taken into account. All classes are removed when leaving
   *    a step.
   *
   *  - Introduce the following new data attributes:
   *
   *    - data-media-autoplay="true": Autostart media when entering its step.
   *    - data-media-autostop="true": Stop media (= pause and reset to start), when leaving its
   *      step.
   *    - data-media-autopause="true": Pause media but keep current time when leaving its step.
   *
   *    When these attributes are added to a step they are inherited by all media on this step.
   *    Of course this setting can be overwritten by adding different attributes to inidvidual
   *    media.
   *
   *    The same rule applies when this attributes is added to the root element. Settings can be
   *    overwritten for individual steps and media.
   *
   *    Examples:
   *    - data-media-autoplay="true" data-media-autostop="true": start media on enter, stop on
   *      leave, restart from beginning when re-entering the step.
   *
   *    - data-media-autoplay="true" data-media-autopause="true": start media on enter, pause on
   *      leave, resume on re-enter
   *
   *    - data-media-autoplay="true" data-media-autostop="true" data-media-autopause="true": start
   *      media on enter, stop on leave (stop overwrites pause).
   *
   *    - data-media-autoplay="true" data-media-autopause="false": let media start automatically
   *      when entering a step and let it play when leaving the step.
   *
   *    - <div id="impress" data-media-autoplay="true"> ... <div class="step"
   *      data-media-autoplay="false">
   *      All media is startet automatically on all steps except the one that has the
   *      data-media-autoplay="false" attribute.
   *
   *  - Pro tip: Use <audio onended="impress().next()"> or <video onended="impress().next()"> to
   *    proceed to the next step automatically, when the end of the media is reached.
   *
   *
   * Copyright 2018 Holger Teichert (@complanar)
   * Released under the MIT license.
   */
  /* global window, document */
  
  ( function( document, window ) {
      "use strict";
      var root, api, gc, attributeTracker;
  
      attributeTracker = [];
  
      // Function names
      var enhanceMediaNodes,
          enhanceMedia,
          removeMediaClasses,
          onStepenterDetectImpressConsole,
          onStepenter,
          onStepleave,
          onPlay,
          onPause,
          onEnded,
          getMediaAttribute,
          teardown;
  
      document.addEventListener( "impress:init", function( event ) {
          root = event.target;
          api = event.detail.api;
          gc = api.lib.gc;
  
          enhanceMedia();
  
          gc.pushCallback( teardown );
      }, false );
  
      teardown = function() {
          var el, i;
          removeMediaClasses();
          for ( i = 0; i < attributeTracker.length; i += 1 ) {
              el = attributeTracker[ i ];
              el.node.removeAttribute( el.attr );
          }
          attributeTracker = [];
      };
  
      getMediaAttribute = function( attributeName, nodes ) {
          var attrName, attrValue, i, node;
          attrName = "data-media-" + attributeName;
  
          // Look for attributes in all nodes
          for ( i = 0; i < nodes.length; i += 1 ) {
              node = nodes[ i ];
  
              // First test, if the attribute exists, because some browsers may return
              // an empty string for non-existing attributes - specs are not clear at that point
              if ( node.hasAttribute( attrName ) ) {
  
                  // Attribute found, return their parsed boolean value, empty strings count as true
                  // to enable empty value booleans (common in html5 but not allowed in well formed
                  // xml).
                  attrValue = node.getAttribute( attrName );
                  if ( attrValue === "" || attrValue === "true" ) {
                      return true;
                  } else {
                      return false;
                  }
              }
  
              // No attribute found at current node, proceed with next round
          }
  
          // Last resort: no attribute found - return undefined to distiguish from false
          return undefined;
      };
  
      onPlay = function( event ) {
          var type = event.target.nodeName.toLowerCase();
          document.body.classList.add( "impress-media-" + type + "-playing" );
          document.body.classList.remove( "impress-media-" + type + "-paused" );
      };
  
      onPause = function( event ) {
          var type = event.target.nodeName.toLowerCase();
          document.body.classList.add( "impress-media-" + type + "-paused" );
          document.body.classList.remove( "impress-media-" + type + "-playing" );
      };
  
      onEnded = function( event ) {
          var type = event.target.nodeName.toLowerCase();
          document.body.classList.remove( "impress-media-" + type + "-playing" );
          document.body.classList.remove( "impress-media-" + type + "-paused" );
      };
  
      removeMediaClasses = function() {
          var type, types;
          types = [ "video", "audio" ];
          for ( type in types ) {
              document.body.classList.remove( "impress-media-" + types[ type ] + "-playing" );
              document.body.classList.remove( "impress-media-" + types[ type ] + "-paused" );
          }
      };
  
      enhanceMediaNodes = function() {
          var i, id, media, mediaElement, type;
  
          media = root.querySelectorAll( "audio, video" );
          for ( i = 0; i < media.length; i += 1 ) {
              type = media[ i ].nodeName.toLowerCase();
  
              // Set an id to identify each media node - used e.g. for cross references by
              // the consoleMedia plugin
              mediaElement = media[ i ];
              id = mediaElement.getAttribute( "id" );
              if ( id === undefined || id === null ) {
                  mediaElement.setAttribute( "id", "media-" + type + "-" + i );
                  attributeTracker.push( { "node": mediaElement, "attr": "id" } );
              }
              gc.addEventListener( mediaElement, "play", onPlay );
              gc.addEventListener( mediaElement, "playing", onPlay );
              gc.addEventListener( mediaElement, "pause", onPause );
              gc.addEventListener( mediaElement, "ended", onEnded );
          }
      };
  
      enhanceMedia = function() {
          var steps, stepElement, i;
          enhanceMediaNodes();
          steps = document.getElementsByClassName( "step" );
          for ( i = 0; i < steps.length; i += 1 ) {
              stepElement = steps[ i ];
  
              gc.addEventListener( stepElement, "impress:stepenter", onStepenter );
              gc.addEventListener( stepElement, "impress:stepleave", onStepleave );
          }
      };
  
      onStepenterDetectImpressConsole = function() {
          return {
              "preview": ( window.frameElement !== null && window.frameElement.id === "preView" ),
              "slideView": ( window.frameElement !== null && window.frameElement.id === "slideView" )
          };
      };
  
      onStepenter = function( event ) {
          var stepElement, media, mediaElement, i, onConsole, autoplay;
          if ( ( !event ) || ( !event.target ) ) {
              return;
          }
  
          stepElement = event.target;
          removeMediaClasses();
  
          media = stepElement.querySelectorAll( "audio, video" );
          for ( i = 0; i < media.length; i += 1 ) {
              mediaElement = media[ i ];
  
              // Autoplay when (maybe inherited) autoplay setting is true,
              // but only if not on preview of the next step in impressConsole
              onConsole = onStepenterDetectImpressConsole();
              autoplay = getMediaAttribute( "autoplay", [ mediaElement, stepElement, root ] );
              if ( autoplay && !onConsole.preview ) {
                  if ( onConsole.slideView ) {
                      mediaElement.muted = true;
                  }
                  mediaElement.play();
              }
          }
      };
  
      onStepleave = function( event ) {
          var stepElement, media, i, mediaElement, autoplay, autopause, autostop;
          if ( ( !event || !event.target ) ) {
              return;
          }
  
          stepElement = event.target;
          media = event.target.querySelectorAll( "audio, video" );
          for ( i = 0; i < media.length; i += 1 ) {
              mediaElement = media[ i ];
  
              autoplay = getMediaAttribute( "autoplay", [ mediaElement, stepElement, root ] );
              autopause = getMediaAttribute( "autopause", [ mediaElement, stepElement, root ] );
              autostop = getMediaAttribute( "autostop",  [ mediaElement, stepElement, root ] );
  
              // If both autostop and autopause are undefined, set it to the value of autoplay
              if ( autostop === undefined && autopause === undefined ) {
                  autostop = autoplay;
              }
  
              if ( autopause || autostop ) {
                  mediaElement.pause();
                  if ( autostop ) {
                      mediaElement.currentTime = 0;
                  }
              }
          }
          removeMediaClasses();
      };
  
  } )( document, window );
  
  /**
   * Mobile devices support
   *
   * Allow presentation creators to hide all but 3 slides, to save resources, particularly on mobile
   * devices, using classes body.impress-mobile, .step.prev, .step.active and .step.next.
   *
   * Note: This plugin does not take into account possible redirections done with skip, goto etc
   * plugins. Basically it wouldn't work as intended in such cases, but the active step will at least
   * be correct.
   *
   * Adapted to a plugin from a submission by @Kzeni:
   * https://github.com/impress/impress.js/issues/333
   */
  /* global document, navigator */
  ( function( document ) {
      "use strict";
  
      var getNextStep = function( el ) {
          var steps = document.querySelectorAll( ".step" );
          for ( var i = 0; i < steps.length; i++ ) {
              if ( steps[ i ] === el ) {
                  if ( i + 1 < steps.length ) {
                      return steps[ i + 1 ];
                  } else {
                      return steps[ 0 ];
                  }
              }
          }
      };
      var getPrevStep = function( el ) {
          var steps = document.querySelectorAll( ".step" );
          for ( var i = steps.length - 1; i >= 0; i-- ) {
              if ( steps[ i ] === el ) {
                  if ( i - 1 >= 0 ) {
                      return steps[ i - 1 ];
                  } else {
                      return steps[ steps.length - 1 ];
                  }
              }
          }
      };
  
      // Detect mobile browsers & add CSS class as appropriate.
      document.addEventListener( "impress:init", function( event ) {
          var body = document.body;
          if ( /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
                   navigator.userAgent
               ) ) {
              body.classList.add( "impress-mobile" );
          }
  
          // Unset all this on teardown
          var api = event.detail.api;
          api.lib.gc.pushCallback( function() {
              document.body.classList.remove( "impress-mobile" );
              var prev = document.getElementsByClassName( "prev" )[ 0 ];
              var next = document.getElementsByClassName( "next" )[ 0 ];
              if ( typeof prev !== "undefined" ) {
                  prev.classList.remove( "prev" );
              }
              if ( typeof next !== "undefined" ) {
                  next.classList.remove( "next" );
              }
          } );
      } );
  
      // Add prev and next classes to the siblings of the newly entered active step element
      // Remove prev and next classes from their current step elements
      // Note: As an exception we break namespacing rules, as these are useful general purpose
      // classes. (Naming rules would require us to use css classes mobile-next and mobile-prev,
      // based on plugin name.)
      document.addEventListener( "impress:stepenter", function( event ) {
            var oldprev = document.getElementsByClassName( "prev" )[ 0 ];
            var oldnext = document.getElementsByClassName( "next" )[ 0 ];
  
            var prev = getPrevStep( event.target );
            prev.classList.add( "prev" );
            var next = getNextStep( event.target );
            next.classList.add( "next" );
  
            if ( typeof oldprev !== "undefined" ) {
                oldprev.classList.remove( "prev" );
                }
            if ( typeof oldnext !== "undefined" ) {
                oldnext.classList.remove( "next" );
                }
      } );
  } )( document );
  
  
  /**
   * Mouse timeout plugin
   *
   * After 3 seconds of mouse inactivity, add the css class
   * `body.impress-mouse-timeout`. On `mousemove`, `click` or `touch`, remove the
   * class.
   *
   * The use case for this plugin is to use CSS to hide elements from the screen
   * and only make them visible when the mouse is moved. Examples where this
   * might be used are: the toolbar from the toolbar plugin, and the mouse cursor
   * itself.
   *
   * Example CSS:
   *
   *     body.impress-mouse-timeout {
   *         cursor: none;
   *     }
   *     body.impress-mouse-timeout div#impress-toolbar {
   *         display: none;
   *     }
   *
   *
   * Copyright 2016 Henrik Ingo (@henrikingo)
   * Released under the MIT license.
   */
  /* global window, document */
  ( function( document, window ) {
      "use strict";
      var timeout = 3;
      var timeoutHandle;
  
      var hide = function() {
  
          // Mouse is now inactive
          document.body.classList.add( "impress-mouse-timeout" );
      };
  
      var show = function() {
          if ( timeoutHandle ) {
              window.clearTimeout( timeoutHandle );
          }
  
          // Mouse is now active
          document.body.classList.remove( "impress-mouse-timeout" );
  
          // Then set new timeout after which it is considered inactive again
          timeoutHandle = window.setTimeout( hide, timeout * 1000 );
      };
  
      document.addEventListener( "impress:init", function( event ) {
          var api = event.detail.api;
          var gc = api.lib.gc;
          gc.addEventListener( document, "mousemove", show );
          gc.addEventListener( document, "click", show );
          gc.addEventListener( document, "touch", show );
  
          // Set first timeout
          show();
  
          // Unset all this on teardown
          gc.pushCallback( function() {
              window.clearTimeout( timeoutHandle );
              document.body.classList.remove( "impress-mouse-timeout" );
          } );
      }, false );
  
  } )( document, window );
  
  /**
   * Navigation events plugin
   *
   * As you can see this part is separate from the impress.js core code.
   * It's because these navigation actions only need what impress.js provides with
   * its simple API.
   *
   * This plugin is what we call an _init plugin_. It's a simple kind of
   * impress.js plugin. When loaded, it starts listening to the `impress:init`
   * event. That event listener initializes the plugin functionality - in this
   * case we listen to some keypress and mouse events. The only dependencies on
   * core impress.js functionality is the `impress:init` method, as well as using
   * the public api `next(), prev(),` etc when keys are pressed.
   *
   * Copyright 2011-2012 Bartek Szopka (@bartaz)
   * Released under the MIT license.
   * ------------------------------------------------
   *  author:  Bartek Szopka
   *  version: 0.5.3
   *  url:     http://bartaz.github.com/impress.js/
   *  source:  http://github.com/bartaz/impress.js/
   *
   */
  /* global document */
  ( function( document ) {
      "use strict";
  
      // Wait for impress.js to be initialized
      document.addEventListener( "impress:init", function( event ) {
  
          // Getting API from event data.
          // So you don't event need to know what is the id of the root element
          // or anything. `impress:init` event data gives you everything you
          // need to control the presentation that was just initialized.
          var api = event.detail.api;
          var gc = api.lib.gc;
          var util = api.lib.util;
  
          // Supported keys are:
          // [space] - quite common in presentation software to move forward
          // [up] [right] / [down] [left] - again common and natural addition,
          // [pgdown] / [pgup] - often triggered by remote controllers,
          // [tab] - this one is quite controversial, but the reason it ended up on
          //   this list is quite an interesting story... Remember that strange part
          //   in the impress.js code where window is scrolled to 0,0 on every presentation
          //   step, because sometimes browser scrolls viewport because of the focused element?
          //   Well, the [tab] key by default navigates around focusable elements, so clicking
          //   it very often caused scrolling to focused element and breaking impress.js
          //   positioning. I didn't want to just prevent this default action, so I used [tab]
          //   as another way to moving to next step... And yes, I know that for the sake of
          //   consistency I should add [shift+tab] as opposite action...
          var isNavigationEvent = function( event ) {
  
              // Don't trigger navigation for example when user returns to browser window with ALT+TAB
              if ( event.altKey || event.ctrlKey || event.metaKey ) {
                  return false;
              }
  
              // In the case of TAB, we force step navigation always, overriding the browser
              // navigation between input elements, buttons and links.
              if ( event.keyCode === 9 ) {
                  return true;
              }
  
              // With the sole exception of TAB, we also ignore keys pressed if shift is down.
              if ( event.shiftKey ) {
                  return false;
              }
  
              if ( ( event.keyCode >= 32 && event.keyCode <= 34 ) ||
                   ( event.keyCode >= 37 && event.keyCode <= 40 ) ) {
                  return true;
              }
          };
  
          // KEYBOARD NAVIGATION HANDLERS
  
          // Prevent default keydown action when one of supported key is pressed.
          gc.addEventListener( document, "keydown", function( event ) {
              if ( isNavigationEvent( event ) ) {
                  event.preventDefault();
              }
          }, false );
  
          // Trigger impress action (next or prev) on keyup.
          gc.addEventListener( document, "keyup", function( event ) {
              if ( isNavigationEvent( event ) ) {
                  if ( event.shiftKey ) {
                      switch ( event.keyCode ) {
                          case 9: // Shift+tab
                              api.prev();
                              break;
                      }
                  } else {
                      switch ( event.keyCode ) {
                          case 33: // Pg up
                          case 37: // Left
                          case 38: // Up
                                   api.prev( event );
                                   break;
                          case 9:  // Tab
                          case 32: // Space
                          case 34: // Pg down
                          case 39: // Right
                          case 40: // Down
                                   api.next( event );
                                   break;
                      }
                  }
                  event.preventDefault();
              }
          }, false );
  
          // Delegated handler for clicking on the links to presentation steps
          gc.addEventListener( document, "click", function( event ) {
  
              // Event delegation with "bubbling"
              // check if event target (or any of its parents is a link)
              var target = event.target;
              try {
                  while ( ( target.tagName !== "A" ) &&
                          ( target !== document.documentElement ) ) {
                      target = target.parentNode;
                  }
  
                  if ( target.tagName === "A" ) {
                      var href = target.getAttribute( "href" );
  
                      // If it's a link to presentation step, target this step
                      if ( href && href[ 0 ] === "#" ) {
                          target = document.getElementById( href.slice( 1 ) );
                      }
                  }
  
                  if ( api.goto( target ) ) {
                      event.stopImmediatePropagation();
                      event.preventDefault();
                  }
              }
              catch ( err ) {
  
                  // For example, when clicking on the button to launch speaker console, the button
                  // is immediately deleted from the DOM. In this case target is a DOM element when
                  // we get it, but turns out to be null if you try to actually do anything with it.
                  if ( err instanceof TypeError &&
                       err.message === "target is null" ) {
                      return;
                  }
                  throw err;
              }
          }, false );
  
          // Delegated handler for clicking on step elements
          gc.addEventListener( document, "click", function( event ) {
              var target = event.target;
              try {
  
                  // Find closest step element that is not active
                  while ( !( target.classList.contains( "step" ) &&
                          !target.classList.contains( "active" ) ) &&
                          ( target !== document.documentElement ) ) {
                      target = target.parentNode;
                  }
  
                  if ( api.goto( target ) ) {
                      event.preventDefault();
                  }
              }
              catch ( err ) {
  
                  // For example, when clicking on the button to launch speaker console, the button
                  // is immediately deleted from the DOM. In this case target is a DOM element when
                  // we get it, but turns out to be null if you try to actually do anything with it.
                  if ( err instanceof TypeError &&
                       err.message === "target is null" ) {
                      return;
                  }
                  throw err;
              }
          }, false );
  
          // Add a line to the help popup
          util.triggerEvent( document, "impress:help:add", { command: "Left &amp; Right",
                                                             text: "Previous &amp; Next step",
                                                             row: 1 } );
  
      }, false );
  
  } )( document );
  
  
  /**
   * Navigation UI plugin
   *
   * This plugin provides UI elements "back", "forward" and a list to select
   * a specific slide number.
   *
   * The navigation controls are added to the toolbar plugin via DOM events. User must enable the
   * toolbar in a presentation to have them visible.
   *
   * Copyright 2016 Henrik Ingo (@henrikingo)
   * Released under the MIT license.
   */
  
  // This file contains so much HTML, that we will just respectfully disagree about js
  /* jshint quotmark:single */
  /* global document */
  
  ( function( document ) {
      'use strict';
      var toolbar;
      var api;
      var root;
      var steps;
      var hideSteps = [];
      var prev;
      var select;
      var next;
  
      var triggerEvent = function( el, eventName, detail ) {
          var event = document.createEvent( 'CustomEvent' );
          event.initCustomEvent( eventName, true, true, detail );
          el.dispatchEvent( event );
      };
  
      var makeDomElement = function( html ) {
          var tempDiv = document.createElement( 'div' );
          tempDiv.innerHTML = html;
          return tempDiv.firstChild;
      };
  
      var selectOptionsHtml = function() {
          var options = '';
          for ( var i = 0; i < steps.length; i++ ) {
  
              // Omit steps that are listed as hidden from select widget
              if ( hideSteps.indexOf( steps[ i ] ) < 0 ) {
                  options = options + '<option value="' + steps[ i ].id + '">' + // jshint ignore:line
                                      steps[ i ].id + '</option>' + '\n'; // jshint ignore:line
              }
          }
          return options;
      };
  
      var addNavigationControls = function( event ) {
          api = event.detail.api;
          var gc = api.lib.gc;
          root = event.target;
          steps = root.querySelectorAll( '.step' );
  
          var prevHtml   = '<button id="impress-navigation-ui-prev" title="Previous" ' +
                           'class="impress-navigation-ui">&lt;</button>';
          var selectHtml = '<select id="impress-navigation-ui-select" title="Go to" ' +
                           'class="impress-navigation-ui">' + '\n' +
                             selectOptionsHtml() +
                             '</select>';
          var nextHtml   = '<button id="impress-navigation-ui-next" title="Next" ' +
                           'class="impress-navigation-ui">&gt;</button>';
  
          prev = makeDomElement( prevHtml );
          prev.addEventListener( 'click',
              function() {
                  api.prev();
          } );
          select = makeDomElement( selectHtml );
          select.addEventListener( 'change',
              function( event ) {
                  api.goto( event.target.value );
          } );
          gc.addEventListener( root, 'impress:steprefresh', function( event ) {
  
              // As impress.js core now allows to dynamically edit the steps, including adding,
              // removing, and reordering steps, we need to requery and redraw the select list on
              // every stepenter event.
              steps = root.querySelectorAll( '.step' );
              select.innerHTML = '\n' + selectOptionsHtml();
  
              // Make sure the list always shows the step we're actually on, even if it wasn't
              // selected from the list
              select.value = event.target.id;
          } );
          next = makeDomElement( nextHtml );
          next.addEventListener( 'click',
              function() {
                  api.next();
          } );
  
          triggerEvent( toolbar, 'impress:toolbar:appendChild', { group: 0, element: prev } );
          triggerEvent( toolbar, 'impress:toolbar:appendChild', { group: 0, element: select } );
          triggerEvent( toolbar, 'impress:toolbar:appendChild', { group: 0, element: next } );
  
      };
  
      // API for not listing given step in the select widget.
      // For example, if you set class="skip" on some element, you may not want it to show up in the
      // list either. Otoh we cannot assume that, or anything else, so steps that user wants omitted
      // must be specifically added with this API call.
      document.addEventListener( 'impress:navigation-ui:hideStep', function( event ) {
          hideSteps.push( event.target );
          if ( select ) {
              select.innerHTML = selectOptionsHtml();
          }
      }, false );
  
      // Wait for impress.js to be initialized
      document.addEventListener( 'impress:init', function( event ) {
          toolbar = document.querySelector( '#impress-toolbar' );
          if ( toolbar ) {
              addNavigationControls( event );
          }
      }, false );
  
  } )( document );
  
  
  /* global document */
  ( function( document ) {
      "use strict";
      var root;
      var stepids = [];
  
      // Get stepids from the steps under impress root
      var getSteps = function() {
          stepids = [];
          var steps = root.querySelectorAll( ".step" );
          for ( var i = 0; i < steps.length; i++ )
          {
            stepids[ i + 1 ] = steps[ i ].id;
          }
          };
  
      // Wait for impress.js to be initialized
      document.addEventListener( "impress:init", function( event ) {
              root = event.target;
          getSteps();
          var gc = event.detail.api.lib.gc;
          gc.pushCallback( function() {
              stepids = [];
              if ( progressbar ) {
                  progressbar.style.width = "";
                          }
              if ( progress ) {
                  progress.innerHTML = "";
                          }
          } );
      } );
  
      var progressbar = document.querySelector( "div.impress-progressbar div" );
      var progress = document.querySelector( "div.impress-progress" );
  
      if ( null !== progressbar || null !== progress ) {
          document.addEventListener( "impress:stepleave", function( event ) {
              updateProgressbar( event.detail.next.id );
          } );
  
          document.addEventListener( "impress:steprefresh", function( event ) {
              getSteps();
              updateProgressbar( event.target.id );
          } );
  
      }
  
      function updateProgressbar( slideId ) {
          var slideNumber = stepids.indexOf( slideId );
          if ( null !== progressbar ) {
                          var width = 100 / ( stepids.length - 1 ) * ( slideNumber );
              progressbar.style.width = width.toFixed( 2 ) + "%";
          }
          if ( null !== progress ) {
              progress.innerHTML = slideNumber + "/" + ( stepids.length - 1 );
          }
      }
  } )( document );
  
  /**
   * Relative Positioning Plugin
   *
   * This plugin provides support for defining the coordinates of a step relative
   * to the previous step. This is often more convenient when creating presentations,
   * since as you add, remove or move steps, you may not need to edit the positions
   * as much as is the case with the absolute coordinates supported by impress.js
   * core.
   *
   * Example:
   *
   *         <!-- Position step 1000 px to the right and 500 px up from the previous step. -->
   *         <div class="step" data-rel-x="1000" data-rel-y="500">
   *
   * Following html attributes are supported for step elements:
   *
   *     data-rel-x
   *     data-rel-y
   *     data-rel-z
   *
   * These values are also inherited from the previous step. This makes it easy to
   * create a boring presentation where each slide shifts for example 1000px down
   * from the previous.
   *
   * In addition to plain numbers, which are pixel values, it is also possible to
   * define relative positions as a multiple of screen height and width, using
   * a unit of "h" and "w", respectively, appended to the number.
   *
   * Example:
   *
   *        <div class="step" data-rel-x="1.5w" data-rel-y="1.5h">
   *
   * This plugin is a *pre-init plugin*. It is called synchronously from impress.js
   * core at the beginning of `impress().init()`. This allows it to process its own
   * data attributes first, and possibly alter the data-x, data-y and data-z attributes
   * that will then be processed by `impress().init()`.
   *
   * (Another name for this kind of plugin might be called a *filter plugin*, but
   * *pre-init plugin* is more generic, as a plugin might do whatever it wants in
   * the pre-init stage.)
   *
   * Copyright 2016 Henrik Ingo (@henrikingo)
   * Released under the MIT license.
   */
  
  /* global document, window */
  
  ( function( document, window ) {
      "use strict";
  
      var startingState = {};
  
      /**
       * Copied from core impress.js. We currently lack a library mechanism to
       * to share utility functions like this.
       */
      var toNumber = function( numeric, fallback ) {
          return isNaN( numeric ) ? ( fallback || 0 ) : Number( numeric );
      };
  
      /**
       * Extends toNumber() to correctly compute also relative-to-screen-size values 5w and 5h.
       *
       * Returns the computed value in pixels with w/h postfix removed.
       */
      var toNumberAdvanced = function( numeric, fallback ) {
          if ( typeof numeric !== "string" ) {
              return toNumber( numeric, fallback );
          }
          var ratio = numeric.match( /^([+-]*[\d\.]+)([wh])$/ );
          if ( ratio == null ) {
              return toNumber( numeric, fallback );
          } else {
              var value = parseFloat( ratio[ 1 ] );
              var multiplier = ratio[ 2 ] === "w" ? window.innerWidth : window.innerHeight;
              return value * multiplier;
          }
      };
  
      var computeRelativePositions = function( el, prev ) {
          var data = el.dataset;
  
          if ( !prev ) {
  
              // For the first step, inherit these defaults
              prev = { x:0, y:0, z:0, relative: { x:0, y:0, z:0 } };
          }
  
          if ( data.relTo ) {
  
              var ref = document.getElementById( data.relTo );
              if ( ref ) {
  
                  // Test, if it is a previous step that already has some assigned position data
                  if ( el.compareDocumentPosition( ref ) & Node.DOCUMENT_POSITION_PRECEDING ) {
                      prev.x = toNumber( ref.getAttribute( "data-x" ) );
                      prev.y = toNumber( ref.getAttribute( "data-y" ) );
                      prev.z = toNumber( ref.getAttribute( "data-z" ) );
                      prev.relative = {};
                  } else {
                      window.console.error(
                          "impress.js rel plugin: Step \"" + data.relTo + "\" is not defined " +
                          "*before* the current step. Referencing is limited to previously defined " +
                          "steps. Please check your markup. Ignoring data-rel-to attribute of " +
                          "this step. Have a look at the documentation for how to create relative " +
                          "positioning to later shown steps with the help of the goto plugin."
                      );
                  }
              } else {
  
                  // Step not found
                  window.console.warn(
                      "impress.js rel plugin: \"" + data.relTo + "\" is not a valid step in this " +
                      "impress.js presentation. Please check your markup. Ignoring data-rel-to " +
                      "attribute of this step."
                  );
              }
          }
  
          var step = {
                  x: toNumber( data.x, prev.x ),
                  y: toNumber( data.y, prev.y ),
                  z: toNumber( data.z, prev.z ),
                  relative: {
                      x: toNumberAdvanced( data.relX, prev.relative.x ),
                      y: toNumberAdvanced( data.relY, prev.relative.y ),
                      z: toNumberAdvanced( data.relZ, prev.relative.z )
                  }
              };
  
          // Relative position is ignored/zero if absolute is given.
          // Note that this also has the effect of resetting any inherited relative values.
          if ( data.x !== undefined ) {
              step.relative.x = 0;
          }
          if ( data.y !== undefined ) {
              step.relative.y = 0;
          }
          if ( data.z !== undefined ) {
              step.relative.z = 0;
          }
  
          // Apply relative position to absolute position, if non-zero
          // Note that at this point, the relative values contain a number value of pixels.
          step.x = step.x + step.relative.x;
          step.y = step.y + step.relative.y;
          step.z = step.z + step.relative.z;
  
          return step;
      };
  
      var rel = function( root ) {
          var steps = root.querySelectorAll( ".step" );
          var prev;
          startingState[ root.id ] = [];
          for ( var i = 0; i < steps.length; i++ ) {
              var el = steps[ i ];
              startingState[ root.id ].push( {
                  el: el,
                  x: el.getAttribute( "data-x" ),
                  y: el.getAttribute( "data-y" ),
                  z: el.getAttribute( "data-z" ),
                  relX: el.getAttribute( "data-rel-x" ),
                  relY: el.getAttribute( "data-rel-y" ),
                  relZ: el.getAttribute( "data-rel-z" )
              } );
              var step = computeRelativePositions( el, prev );
  
              // Apply relative position (if non-zero)
              el.setAttribute( "data-x", step.x );
              el.setAttribute( "data-y", step.y );
              el.setAttribute( "data-z", step.z );
              prev = step;
          }
      };
  
      // Register the plugin to be called in pre-init phase
      window.impress.addPreInitPlugin( rel );
  
      // Register teardown callback to reset the data.x, .y, .z values.
      document.addEventListener( "impress:init", function( event ) {
          var root = event.target;
          event.detail.api.lib.gc.pushCallback( function() {
              var steps = startingState[ root.id ];
              var step;
              while ( step = steps.pop() ) {
  
                  // Reset x/y/z in cases where this plugin has changed it.
                  if ( step.relX !== null ) {
                      if ( step.x === null ) {
                          step.el.removeAttribute( "data-x" );
                      } else {
                          step.el.setAttribute( "data-x", step.x );
                      }
                  }
                  if ( step.relY !== null ) {
                      if ( step.y === null ) {
                          step.el.removeAttribute( "data-y" );
                      } else {
                          step.el.setAttribute( "data-y", step.y );
                      }
                  }
                  if ( step.relZ !== null ) {
                      if ( step.z === null ) {
                          step.el.removeAttribute( "data-z" );
                      } else {
                          step.el.setAttribute( "data-z", step.z );
                      }
                  }
              }
              delete startingState[ root.id ];
          } );
      }, false );
  } )( document, window );
  
  
  /**
   * Resize plugin
   *
   * Rescale the presentation after a window resize.
   *
   * Copyright 2011-2012 Bartek Szopka (@bartaz)
   * Released under the MIT license.
   * ------------------------------------------------
   *  author:  Bartek Szopka
   *  version: 0.5.3
   *  url:     http://bartaz.github.com/impress.js/
   *  source:  http://github.com/bartaz/impress.js/
   *
   */
  
  /* global document, window */
  
  ( function( document, window ) {
      "use strict";
  
      // Wait for impress.js to be initialized
      document.addEventListener( "impress:init", function( event ) {
          var api = event.detail.api;
  
          // Rescale presentation when window is resized
          api.lib.gc.addEventListener( window, "resize", api.lib.util.throttle( function() {
  
              // Force going to active step again, to trigger rescaling
              api.goto( document.querySelector( ".step.active" ), 500 );
          }, 250 ), false );
      }, false );
  
  } )( document, window );
  
  
  /**
   * Skip Plugin
   *
   * Example:
   *
   *    <!-- This slide is disabled in presentations, when moving with next()
   *         and prev() commands, but you can still move directly to it, for
   *         example with a url (anything using goto()). -->
   *         <div class="step skip">
   *
   * Copyright 2016 Henrik Ingo (@henrikingo)
   * Released under the MIT license.
   */
  
  /* global document, window */
  
  ( function( document, window ) {
      "use strict";
      var util;
  
      document.addEventListener( "impress:init", function( event ) {
          util = event.detail.api.lib.util;
      }, false );
  
      var getNextStep = function( el ) {
          var steps = document.querySelectorAll( ".step" );
          for ( var i = 0; i < steps.length; i++ ) {
              if ( steps[ i ] === el ) {
                  if ( i + 1 < steps.length ) {
                      return steps[ i + 1 ];
                  } else {
                      return steps[ 0 ];
                  }
              }
          }
      };
      var getPrevStep = function( el ) {
          var steps = document.querySelectorAll( ".step" );
          for ( var i = steps.length - 1; i >= 0; i-- ) {
              if ( steps[ i ] === el ) {
                  if ( i - 1 >= 0 ) {
                      return steps[ i - 1 ];
                  } else {
                      return steps[ steps.length - 1 ];
                  }
              }
          }
      };
  
      var skip = function( event ) {
          if ( ( !event ) || ( !event.target ) ) {
              return;
          }
  
          if ( event.detail.next.classList.contains( "skip" ) ) {
              if ( event.detail.reason === "next" ) {
  
                  // Go to the next next step instead
                  event.detail.next = getNextStep( event.detail.next );
  
                  // Recursively call this plugin again, until there's a step not to skip
                  skip( event );
              } else if ( event.detail.reason === "prev" ) {
  
                  // Go to the previous previous step instead
                  event.detail.next = getPrevStep( event.detail.next );
                  skip( event );
              }
  
              // If the new next element has its own transitionDuration, we're responsible for setting
              // that on the event as well
              event.detail.transitionDuration = util.toNumber(
                  event.detail.next.dataset.transitionDuration, event.detail.transitionDuration
              );
          }
      };
  
      // Register the plugin to be called in pre-stepleave phase
      // The weight makes this plugin run early. This is a good thing, because this plugin calls
      // itself recursively.
      window.impress.addPreStepLeavePlugin( skip, 1 );
  
  } )( document, window );
  
  
  /**
   * Stop Plugin
   *
   * Example:
   *
   *        <!-- Stop at this slide.
   *             (For example, when used on the last slide, this prevents the
   *             presentation from wrapping back to the beginning.) -->
   *        <div class="step stop">
   *
   * Copyright 2016 Henrik Ingo (@henrikingo)
   * Released under the MIT license.
   */
  /* global document, window */
  ( function( document, window ) {
      "use strict";
  
      var stop = function( event ) {
          if ( ( !event ) || ( !event.target ) ) {
              return;
          }
  
          if ( event.target.classList.contains( "stop" ) ) {
              if ( event.detail.reason === "next" ) {
                  return false;
              }
          }
      };
  
      // Register the plugin to be called in pre-stepleave phase
      // The weight makes this plugin run fairly early.
      window.impress.addPreStepLeavePlugin( stop, 2 );
  
  } )( document, window );
  
  
  /**
   * Substep Plugin
   *
   * Copyright 2017 Henrik Ingo (@henrikingo)
   * Released under the MIT license.
   */
  
  /* global document, window */
  
  ( function( document, window ) {
      "use strict";
  
      // Copied from core impress.js. Good candidate for moving to src/lib/util.js.
      var triggerEvent = function( el, eventName, detail ) {
          var event = document.createEvent( "CustomEvent" );
          event.initCustomEvent( eventName, true, true, detail );
          el.dispatchEvent( event );
      };
  
      var activeStep = null;
      document.addEventListener( "impress:stepenter", function( event ) {
          activeStep = event.target;
      }, false );
  
      var substep = function( event ) {
          if ( ( !event ) || ( !event.target ) ) {
              return;
          }
  
          var step = event.target;
          var el; // Needed by jshint
          if ( event.detail.reason === "next" ) {
              el = showSubstepIfAny( step );
              if ( el ) {
  
                  // Send a message to others, that we aborted a stepleave event.
                  triggerEvent( step, "impress:substep:stepleaveaborted",
                                { reason: "next", substep: el } );
  
                  // Autoplay uses this for reloading itself
                  triggerEvent( step, "impress:substep:enter",
                                { reason: "next", substep: el } );
  
                  // Returning false aborts the stepleave event
                  return false;
              }
          }
          if ( event.detail.reason === "prev" ) {
              el = hideSubstepIfAny( step );
              if ( el ) {
                  triggerEvent( step, "impress:substep:stepleaveaborted",
                                { reason: "prev", substep: el } );
  
                  triggerEvent( step, "impress:substep:leave",
                                { reason: "prev", substep: el } );
  
                  return false;
              }
          }
      };
  
      var showSubstepIfAny = function( step ) {
          var substeps = step.querySelectorAll( ".substep" );
          var visible = step.querySelectorAll( ".substep-visible" );
          if ( substeps.length > 0 ) {
              return showSubstep( substeps, visible );
          }
      };
  
      var showSubstep = function( substeps, visible ) {
          if ( visible.length < substeps.length ) {
              for ( var i = 0; i < substeps.length; i++ ) {
                  substeps[ i ].classList.remove( "substep-active" );
              }
              var el = substeps[ visible.length ];
              el.classList.add( "substep-visible" );
              el.classList.add( "substep-active" );
              return el;
          }
      };
  
      var hideSubstepIfAny = function( step ) {
          var substeps = step.querySelectorAll( ".substep" );
          var visible = step.querySelectorAll( ".substep-visible" );
          if ( substeps.length > 0 ) {
              return hideSubstep( visible );
          }
      };
  
      var hideSubstep = function( visible ) {
          if ( visible.length > 0 ) {
              var current = -1;
              for ( var i = 0; i < visible.length; i++ ) {
                  if ( visible[ i ].classList.contains( "substep-active" ) ) {
                      current = i;
                  }
                  visible[ i ].classList.remove( "substep-active" );
              }
              if ( current > 0 ) {
                  visible[ current - 1 ].classList.add( "substep-active" );
              }
              var el = visible[ visible.length - 1 ];
              el.classList.remove( "substep-visible" );
              return el;
          }
      };
  
      // Register the plugin to be called in pre-stepleave phase.
      // The weight makes this plugin run before other preStepLeave plugins.
      window.impress.addPreStepLeavePlugin( substep, 1 );
  
      // When entering a step, in particular when re-entering, make sure that all substeps are hidden
      // at first
      document.addEventListener( "impress:stepenter", function( event ) {
          var step = event.target;
          var visible = step.querySelectorAll( ".substep-visible" );
          for ( var i = 0; i < visible.length; i++ ) {
              visible[ i ].classList.remove( "substep-visible" );
          }
      }, false );
  
      // API for others to reveal/hide next substep ////////////////////////////////////////////////
      document.addEventListener( "impress:substep:show", function() {
          showSubstepIfAny( activeStep );
      }, false );
  
      document.addEventListener( "impress:substep:hide", function() {
          hideSubstepIfAny( activeStep );
      }, false );
  
  } )( document, window );
  
  /**
   * Support for swipe and tap on touch devices
   *
   * This plugin implements navigation for plugin devices, via swiping left/right,
   * or tapping on the left/right edges of the screen.
   *
   *
   *
   * Copyright 2015: Andrew Dunai (@and3rson)
   * Modified to a plugin, 2016: Henrik Ingo (@henrikingo)
   *
   * MIT License
   */
  /* global document, window */
  ( function( document, window ) {
      "use strict";
  
      // Touch handler to detect swiping left and right based on window size.
      // If the difference in X change is bigger than 1/20 of the screen width,
      // we simply call an appropriate API function to complete the transition.
      var startX = 0;
      var lastX = 0;
      var lastDX = 0;
      var threshold = window.innerWidth / 20;
  
      document.addEventListener( "touchstart", function( event ) {
          lastX = startX = event.touches[ 0 ].clientX;
      } );
  
      document.addEventListener( "touchmove", function( event ) {
           var x = event.touches[ 0 ].clientX;
           var diff = x - startX;
  
           // To be used in touchend
           lastDX = lastX - x;
           lastX = x;
  
           window.impress().swipe( diff / window.innerWidth );
       } );
  
       document.addEventListener( "touchend", function() {
           var totalDiff = lastX - startX;
           if ( Math.abs( totalDiff ) > window.innerWidth / 5 && ( totalDiff * lastDX ) <= 0 ) {
               if ( totalDiff > window.innerWidth / 5 && lastDX <= 0 ) {
                   window.impress().prev();
               } else if ( totalDiff < -window.innerWidth / 5 && lastDX >= 0 ) {
                   window.impress().next();
               }
           } else if ( Math.abs( lastDX ) > threshold ) {
               if ( lastDX < -threshold ) {
                   window.impress().prev();
               } else if ( lastDX > threshold ) {
                   window.impress().next();
               }
           } else {
  
               // No movement - move (back) to the current slide
               window.impress().goto( document.querySelector( "#impress .step.active" ) );
           }
       } );
  
       document.addEventListener( "touchcancel", function() {
  
               // Move (back) to the current slide
               window.impress().goto( document.querySelector( "#impress .step.active" ) );
       } );
  
  } )( document, window );
  
  /**
   * Toolbar plugin
   *
   * This plugin provides a generic graphical toolbar. Other plugins that
   * want to expose a button or other widget, can add those to this toolbar.
   *
   * Using a single consolidated toolbar for all GUI widgets makes it easier
   * to position and style the toolbar rather than having to do that for lots
   * of different divs.
   *
   *
   * *** For presentation authors: *****************************************
   *
   * To add/activate the toolbar in your presentation, add this div:
   *
   *     <div id="impress-toolbar"></div>
   *
   * Styling the toolbar is left to presentation author. Here's an example CSS:
   *
   *    .impress-enabled div#impress-toolbar {
   *        position: fixed;
   *        right: 1px;
   *        bottom: 1px;
   *        opacity: 0.6;
   *    }
   *    .impress-enabled div#impress-toolbar > span {
   *        margin-right: 10px;
   *    }
   *
   * The [mouse-timeout](../mouse-timeout/README.md) plugin can be leveraged to hide
   * the toolbar from sight, and only make it visible when mouse is moved.
   *
   *    body.impress-mouse-timeout div#impress-toolbar {
   *        display: none;
   *    }
   *
   *
   * *** For plugin authors **********************************************
   *
   * To add a button to the toolbar, trigger the `impress:toolbar:appendChild`
   * or `impress:toolbar:insertBefore` events as appropriate. The detail object
   * should contain following parameters:
   *
   *    { group : 1,                       // integer. Widgets with the same group are grouped inside
   *                                       // the same <span> element.
   *      html : "<button>Click</button>", // The html to add.
   *      callback : "mycallback",         // Toolbar plugin will trigger event
   *                                       // `impress:toolbar:added:mycallback` when done.
   *      before: element }                // The reference element for an insertBefore() call.
   *
   * You should also listen to the `impress:toolbar:added:mycallback` event. At
   * this point you can find the new widget in the DOM, and for example add an
   * event listener to it.
   *
   * You are free to use any integer for the group. It's ok to leave gaps. It's
   * ok to co-locate with widgets for another plugin, if you think they belong
   * together.
   *
   * See navigation-ui for an example.
   *
   * Copyright 2016 Henrik Ingo (@henrikingo)
   * Released under the MIT license.
   */
  
  /* global document */
  
  ( function( document ) {
      "use strict";
      var toolbar = document.getElementById( "impress-toolbar" );
      var groups = [];
  
      /**
       * Get the span element that is a child of toolbar, identified by index.
       *
       * If span element doesn't exist yet, it is created.
       *
       * Note: Because of Run-to-completion, this is not a race condition.
       * https://developer.mozilla.org/en/docs/Web/JavaScript/EventLoop#Run-to-completion
       *
       * :param: index   Method will return the element <span id="impress-toolbar-group-{index}">
       */
      var getGroupElement = function( index ) {
          var id = "impress-toolbar-group-" + index;
          if ( !groups[ index ] ) {
              groups[ index ] = document.createElement( "span" );
              groups[ index ].id = id;
              var nextIndex = getNextGroupIndex( index );
              if ( nextIndex === undefined ) {
                  toolbar.appendChild( groups[ index ] );
              } else {
                  toolbar.insertBefore( groups[ index ], groups[ nextIndex ] );
              }
          }
          return groups[ index ];
      };
  
      /**
       * Get the span element from groups[] that is immediately after given index.
       *
       * This can be used to find the reference node for an insertBefore() call.
       * If no element exists at a larger index, returns undefined. (In this case,
       * you'd use appendChild() instead.)
       *
       * Note that index needn't itself exist in groups[].
       */
      var getNextGroupIndex = function( index ) {
          var i = index + 1;
          while ( !groups[ i ] && i < groups.length ) {
              i++;
          }
          if ( i < groups.length ) {
              return i;
          }
      };
  
      // API
      // Other plugins can add and remove buttons by sending them as events.
      // In return, toolbar plugin will trigger events when button was added.
      if ( toolbar ) {
          /**
           * Append a widget inside toolbar span element identified by given group index.
           *
           * :param: e.detail.group    integer specifying the span element where widget will be placed
           * :param: e.detail.element  a dom element to add to the toolbar
           */
          toolbar.addEventListener( "impress:toolbar:appendChild", function( e ) {
              var group = getGroupElement( e.detail.group );
              group.appendChild( e.detail.element );
          } );
  
          /**
           * Add a widget to toolbar using insertBefore() DOM method.
           *
           * :param: e.detail.before   the reference dom element, before which new element is added
           * :param: e.detail.element  a dom element to add to the toolbar
           */
          toolbar.addEventListener( "impress:toolbar:insertBefore", function( e ) {
              toolbar.insertBefore( e.detail.element, e.detail.before );
          } );
  
          /**
           * Remove the widget in e.detail.remove.
           */
          toolbar.addEventListener( "impress:toolbar:removeWidget", function( e ) {
              toolbar.removeChild( e.detail.remove );
          } );
  
          document.addEventListener( "impress:init", function( event ) {
              var api = event.detail.api;
              api.lib.gc.pushCallback( function() {
                  toolbar.innerHTML = "";
                  groups = [];
              } );
          } );
      } // If toolbar
  
  } )( document );
  
  impress().init();
  