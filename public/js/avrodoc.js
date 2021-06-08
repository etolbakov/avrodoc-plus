/* global dust:false, markdown:false, Sammy:false */

// If foo contains markdown, {foo|md|s} renders it to HTML in a Dust template
dust.filters.md = function (value) {
  return markdown.toHTML(value);
};

// eslint-disable-next-line
function AvroDoc(input_schemata) {
  var _public = {};
  var list_pane = $("#list-pane"),
    content_pane = $("#content-pane");
  var schema_by_name = {};
  var shared_types = {};

  // popover_by_name[filename][qualified_name] = {title: 'html', content: 'html'}
  var popover_by_name = {};

  // Render all the popovers ahead of time, because Dust's rendering is async but the popover
  // plugin expects to receive the popover content synchronously when it is triggered.
  function renderPopovers() {
    for (const [filename, schema] of Object.entries(schema_by_name)) {
      popover_by_name[filename] = {};
      Object.entries(schema.named_types).forEach(([qualified_name, type]) => {
        let popover = (popover_by_name[filename][qualified_name] = {});

        // Do the actual rendering in the background, to keep the page responsive
        window.setTimeout(function () {
          dust.render("popover_title", type, function (err, html) {
            popover.title = html;
          });
          dust.render("named_type_details", type, function (err, html) {
            popover.content = html;
          });
        }, 100);
      });
    }
  }

  // Configures all links to types in the current content pane to show popovers on hover.
  function setupPopovers() {
    content_pane.find('a[href^="#/schema/"]').each(function () {
      var url_segments = $(this).attr("href").split("/");
      var schema_popovers =
        popover_by_name[decodeURIComponent(url_segments[2])];
      if (!schema_popovers) return;
      var popover = schema_popovers[decodeURIComponent(url_segments[3])];
      if (!popover) return;

      $(this).popover({
        trigger: "hover",
        placement: "bottom",
        title: function () {
          return popover.title;
        },
        content: function () {
          return popover.content;
        },
        html: true,
        sanitize: false,
        delay: { show: 200, hide: 50 },
        template:
          '<div class="popover avrodoc-named-type"><div class="arrow"></div><div class="popover-inner"><h3 class="popover-title"></h3><div class="popover-content"><div></div></div></div></div>',
      });
    });
  }

  // Renders the named template with the given context and updates the content pane to show the
  // result.
  function renderContentPane(template, context) {
    // Clean up old content
    list_pane.find("li").removeClass("selected");
    $("body > .popover").remove();
    $("body").scrollTop(0);

    dust.render(template, context, function (err, html) {
      content_pane.html(html);
      setupPopovers();
    });
  }

  // Renders the details of the given type in the main content pane.
  function showType(type) {
    if (!type) {
      content_pane.empty();
    } else {
      renderContentPane("named_type", type);

      // Mark the currently displayed type with a 'selected' CSS class in the type list
      list_pane
        .find("a")
        .filter(function () {
          return $(this).attr("href") === type.shared_link;
        })
        .closest("li")
        .addClass("selected");
    }
  }

  // Returns a mapping from qualified name to shared type. A shared type may have one or more
  // versions (conflicting definitions for the same qualified name). Each version may have one or
  // more definitions (equivalent definitions of the same type in different schema files).
  function typeByQualifiedName() {
    const by_qualified_name = {};
    for (const [qualified_name, versions] of Object.entries(shared_types)) {
      by_qualified_name[qualified_name] = { ...versions[0] };
      by_qualified_name[qualified_name].versions = versions;
    }
    return by_qualified_name;
  }

  // Groups the types defined in all schemas by namespace, and sorts them alphabetically.
  // A namespace has many named types (records, enums or fixed).
  function typesByNamespace() {
    const namespaces = {};
    for (const shared_type of Object.values(_public.by_qualified_name)) {
      if (
        shared_type.is_record ||
        shared_type.is_enum ||
        shared_type.is_fixed
      ) {
        const namespace = shared_type.namespace || "";
        if (!hasOwnProperty(namespaces, namespace)) {
          namespaces[namespace] = { namespace, types: [] };
        }
        namespaces[namespace].types.push(shared_type);
      }
    }

    return Object.values(namespaces)
      .sort(stringCompareBy("namespace"))
      .map(function (ns_types) {
        return {
          namespace: ns_types.namespace || "No namespace",
          types: [...ns_types.types].sort(stringCompareBy("name")),
        };
      });
  }

  // Selects all the protocols from all namespaces, and sorts them alphabetically.
  function protocolsSorted() {
    const protocols = Object.values(_public.by_qualified_name).filter(
      (shared_type) => shared_type.is_protocol
    );

    return protocols.sort(stringCompareBy("qualified_name"));
  }

  // Call this once when the schemata have been loaded and we want to launch the app.
  function ready() {
    // Fields used by the schema_list template
    _public.schemata = Object.values(schema_by_name);
    _public.by_qualified_name = typeByQualifiedName();
    _public.namespaces = typesByNamespace();
    _public.protocols = protocolsSorted();
    renderPopovers();

    dust.render("schema_list", _public, function (err, html) {
      list_pane.html(html);
    });

    Sammy(function () {
      this.get("#/schema/:filename/:qualified_name", function () {
        var schema = schema_by_name[this.params.filename];
        showType(schema && schema.named_types[this.params.qualified_name]);
      });

      this.get("#/schema/:qualified_name", function () {
        showType(_public.by_qualified_name[this.params.qualified_name]);
      });

      this.get("#/", function () {
        if (_public.schemata.length === 1) {
          showType(_public.schemata[0].root_type);
        } else {
          renderContentPane("schema_file_list", _public);
        }
      });

      this.notFound = function () {
        window.location.hash = "#/";
      };
    }).run();
  }

  function addSchema(json, filename) {
    filename = filename || "default";

    // If the name is already taken, append a number to make it unique
    if (schema_by_name[filename]) {
      let i = 1;
      while (schema_by_name[filename + i]) i++;
      filename = filename + i;
    }

    schema_by_name[filename] = AvroDoc.Schema(
      _public,
      shared_types,
      json,
      filename
    );
  }

  // Load any schemata that were specified by filename. When they are loaded, start up the app.
  var in_progress = 0,
    schemata_to_load;

  _public.input_schemata = input_schemata ?? [];
  _public.input_schemata.forEach(function (schema) {
    if (schema.json) {
      addSchema(schema.json, schema.filename);
    } else if (schema.filename) {
      in_progress++;
      $.getJSON(schema.filename, function (json) {
        addSchema(json, schema.filename);
        in_progress--;
        if (in_progress === 0) {
          content_pane.text("Processing...");
          window.setTimeout(ready, 10);
        } else {
          content_pane.text(
            "Loaded " +
              (schemata_to_load - in_progress) +
              " out of " +
              schemata_to_load +
              " schemata..."
          );
        }
      });
    } else {
      throw "You must specify JSON or a filename for a schema";
    }
  });

  schemata_to_load = in_progress;

  if (in_progress === 0) {
    ready();
  }

  return _public;
}

function search(text, showNamespace) {
  text = text.toLowerCase();
  var schemas = $(".schema").map(function (index, e) {
    var el = $(e);
    return {
      name: el.data("schema"),
      element: el,
      namespaceElement: el.parent(),
    };
  });
  schemas.each(function (index, schema) {
    if (
      schema.namespaceElement.data("schemas").toLowerCase().includes(text) ||
      schema.namespaceElement.data("namespace").toLowerCase().includes(text)
    ) {
      schema.namespaceElement.show();

      if (showNamespace) {
        schema.element.show();
      } else if (schema.name.toLowerCase().includes(text)) {
        schema.element.show();
      } else {
        schema.element.hide();
      }
    } else {
      schema.namespaceElement.hide();
      schema.element.hide();
    }
  });
}

$(function () {
  setTimeout(function () {
    $("#search-schemas").on("keyup", function () {
      var text = $(this).val();
      var showNamespace = $("#showNamespace").prop("checked");
      search(text, showNamespace);
    });

    $("#showNamespace").on("change", function () {
      var text = $("#search-schemas").val();
      var showNamespace = $(this).prop("checked");
      search(text, showNamespace);
    });
  }, 1000);
});

/**
 * Case insensitive string compare
 *
 * @param {string} property to compare by
 * @returns {function(object, object): boolean} objects to have a property compared
 */
export const stringCompareBy = (property) => (a, b) => {
  const aProp = a[property] ?? "";
  const bProp = b[property] ?? "";
  return aProp.localeCompare(bProp);
};

/**
 * Checks if property exists on object
 *
 * @param {object} object
 * @param {string} property
 * @returns {boolean}
 */
export const hasOwnProperty = (object, property) =>
  Object.prototype.hasOwnProperty.call(object, property);
