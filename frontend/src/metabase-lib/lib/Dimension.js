import React from "react";
import { t, ngettext, msgid } from "ttag";

import Icon from "metabase/components/Icon";

import { stripId } from "metabase/lib/formatting";
import { getFriendlyName } from "metabase/visualizations/lib/utils";
import Query_DEPRECATED from "metabase/lib/query";

import _ from "underscore";

import Field from "./metadata/Field";
import Metadata from "./metadata/Metadata";

import type {
  ConcreteField,
  LocalFieldReference,
  ForeignFieldReference,
  DatetimeField,
  ExpressionReference,
  DatetimeUnit,
} from "metabase/meta/types/Query";

import type { IconName } from "metabase/meta/types";

/**
 * A dimension option returned by the query_metadata API
 */
type DimensionOption = {
  mbql: any,
  name?: string,
};

/* Heirarchy:
 *
 * - Dimension (abstract)
 *   - FieldDimension
 *     - FieldIDDimension
 *     - FieldLiteralDimension
 *     - FKDimension
 *     - BinnedDimension
 *     - DatetimeFieldDimension
 *   - ExpressionDimension
 *   - AggregationDimension
 */

/**
 * Dimension base class, represents an MBQL field reference.
 *
 * Used for displaying fields (like Created At) and their "sub-dimensions" (like Created At by Day)
 * in field lists and active value widgets for filters, aggregations and breakouts.
 *
 * @abstract
 */
export default class Dimension {
  _parent: ?Dimension;
  _args: any;
  _metadata: ?Metadata;

  // Display names provided by the backend
  _subDisplayName: ?String;
  _subTriggerDisplayName: ?String;

  /**
   * Dimension constructor
   */
  constructor(
    parent: ?Dimension,
    args: any[],
    metadata?: Metadata,
    query?: ?StructuredQuery,
  ) {
    this._parent = parent;
    this._args = args;
    this._metadata = metadata || (parent && parent._metadata);
    this._query = query || (parent && parent._query);
  }

  /**
   * Parses an MBQL expression into an appropriate Dimension subclass, if possible.
   * Metadata should be provided if you intend to use the display name or render methods.
   */
  static parseMBQL(
    mbql: ConcreteField,
    metadata?: Metadata,
    query?: ?StructuredQuery,
  ): ?Dimension {
    for (const D of DIMENSION_TYPES) {
      const dimension = D.parseMBQL(mbql, metadata, query);
      if (dimension != null) {
        return dimension;
      }
    }
    return null;
  }

  /**
   * Returns true if these two dimensions are identical to one another.
   */
  static isEqual(a: ?Dimension | ConcreteField, b: ?Dimension): boolean {
    let dimensionA: ?Dimension =
      a instanceof Dimension
        ? a
        : // $FlowFixMe
          Dimension.parseMBQL(a);
    let dimensionB: ?Dimension =
      b instanceof Dimension
        ? b
        : // $FlowFixMe
          Dimension.parseMBQL(b);
    return !!dimensionA && !!dimensionB && dimensionA.isEqual(dimensionB);
  }

  /**
   * Sub-dimensions for the provided dimension of this type.
   * @abstract
   */
  // TODO Atte Keinänen 5/21/17: Rename either this or the instance method with the same name
  // Also making it clear in the method name that we're working with sub-dimensions would be good
  static dimensions(parent: Dimension): Dimension[] {
    return [];
  }

  /**
   * The default sub-dimension for the provided dimension of this type, if any.
   * @abstract
   */
  static defaultDimension(parent: Dimension): ?Dimension {
    return null;
  }

  /**
   * Returns "sub-dimensions" of this dimension.
   * @abstract
   */
  // TODO Atte Keinänen 5/21/17: Rename either this or the static method with the same name
  // Also making it clear in the method name that we're working with sub-dimensions would be good
  dimensions(DimensionTypes?: typeof Dimension[]): Dimension[] {
    const dimensionOptions = this.field().dimension_options;
    if (!DimensionTypes && dimensionOptions) {
      return dimensionOptions.map(option => this._dimensionForOption(option));
    } else {
      return [].concat(
        ...(DimensionTypes || []).map(DimensionType =>
          DimensionType.dimensions(this),
        ),
      );
    }
  }

  /**
   * Returns the default sub-dimension of this dimension, if any.
   * @abstract
   */
  defaultDimension(DimensionTypes: any[] = DIMENSION_TYPES): ?Dimension {
    const defaultDimensionOption = this.field().default_dimension_option;
    if (defaultDimensionOption) {
      const dimension = this._dimensionForOption(defaultDimensionOption);
      // NOTE: temporarily disable for DatetimeFieldDimension until backend automatically picks appropriate bucketing
      if (!(dimension instanceof DatetimeFieldDimension)) {
        return dimension;
      }
    }

    for (const DimensionType of DimensionTypes) {
      const defaultDimension = DimensionType.defaultDimension(this);
      if (defaultDimension) {
        return defaultDimension;
      }
    }

    return null;
  }

  /**
   * Returns MBQL for the default breakout
   *
   * Tries to look up a default subdimension (like "Created At: Day" for "Created At" field)
   * and if it isn't found, uses the plain field id dimension (like "Product ID") as a fallback.
   */
  defaultBreakout() {
    const defaultSubDimension = this.defaultDimension();
    if (defaultSubDimension) {
      return defaultSubDimension.mbql();
    } else {
      return this.mbql();
    }
  }

  defaultAggregation() {
    const aggregations = this.field().aggregations();
    if (aggregations && aggregations.length > 0) {
      return [aggregations[0].short, this.mbql()];
    }
    return null;
  }

  // Internal method gets a Dimension from a DimensionOption
  _dimensionForOption(option: DimensionOption) {
    // fill in the parent field ref
    const fieldRef = this.baseDimension().mbql();
    let mbql = option.mbql;
    if (mbql) {
      mbql = [mbql[0], fieldRef, ...mbql.slice(2)];
    } else {
      mbql = fieldRef;
    }
    let dimension = Dimension.parseMBQL(mbql, this._metadata, this._query);
    if (option.name) {
      dimension._subDisplayName = option.name;
      dimension._subTriggerDisplayName = option.name;
    }
    return dimension;
  }

  /**
   * Is this dimension idential to another dimension or MBQL clause
   */
  isEqual(other: ?Dimension | ConcreteField): boolean {
    if (other == null) {
      return false;
    }

    let otherDimension: ?Dimension =
      other instanceof Dimension
        ? other
        : Dimension.parseMBQL(other, this._metadata, this._query);
    if (!otherDimension) {
      return false;
    }
    // assumes .mbql() returns canonical form
    return _.isEqual(this.mbql(), otherDimension.mbql());
  }

  /**
   * Does this dimension have the same underlying base dimension, typically a field
   */
  isSameBaseDimension(other: ?Dimension | ConcreteField): boolean {
    if (other == null) {
      return false;
    }

    let otherDimension: ?Dimension =
      other instanceof Dimension
        ? other
        : Dimension.parseMBQL(other, this._metadata, this._query);

    const baseDimensionA = this.baseDimension();
    const baseDimensionB = otherDimension && otherDimension.baseDimension();

    return (
      !!baseDimensionA &&
      !!baseDimensionB &&
      baseDimensionA.isEqual(baseDimensionB)
    );
  }

  /**
   * The base dimension of this dimension, typically a field. May return itself.
   */
  baseDimension(): Dimension {
    return this;
  }

  /**
   * The underlying field for this dimension
   */
  field(): Field {
    return new Field();
  }

  /**
   * The `name` appearing in the column object (except duplicates would normally be suffxied)
   */
  columnName(): string {
    return this.field().name;
  }

  /**
   * Valid filter operators on this dimension
   * TODO: rename filterOperator()
   */
  operatorOptions() {
    return this.baseDimension().field().operators || [];
  }

  /**
   * The operator with the provided operator name (e.x. `=`, `<`, etc)
   * TODO: rename filterOperators()
   */
  operator(op) {
    return this.field().operator(op);
  }

  /**
   * The default operator for this
   */
  defaultOperator() {
    // let the DatePicker choose the default operator, otherwise use the first one
    // TODO: replace with a defaultFilter()- or similar which includes arguments
    const operators = this.operatorOptions();
    return this.field().isDate() ? null : operators[0] && operators[0].name;
  }

  /**
   * Returns a new filter MBQL
   */
  filter(op, ...args) {
    const operatorName = typeof op === "string" ? op : op.name;
    return [operatorName, this.mbql(), ...args];
  }

  /**
   * Valid filter operators on this dimension
   */
  aggregations() {
    return this.field().aggregations() || [];
  }

  /**
   * The display name of this dimension, e.x. the field's display_name
   * @abstract
   */
  displayName(): string {
    return "";
  }

  column() {
    return {
      name: this.columnName(),
      display_name: this.displayName(),
      ...this.baseDimension()
        .field()
        .column(),
    };
  }

  /**
   * The name to be shown when this dimension is being displayed as a sub-dimension of another
   * @abstract
   */
  subDisplayName(): string {
    return this._subDisplayName || "";
  }

  /**
   * A shorter version of subDisplayName, e.x. to be shown in the dimension picker trigger
   * @abstract
   */
  subTriggerDisplayName(): string {
    return this._subTriggerDisplayName || "";
  }

  /**
   * An icon name representing this dimension's type, to be used in the <Icon> component.
   * @abstract
   */
  icon(): ?IconName {
    return null;
  }

  /**
   * Renders a dimension to React
   */
  render(): ?React$Element<any> {
    return this._parent ? this._parent.render() : [this.displayName()];
  }

  mbql() {
    throw new Error("Abstract method `mbql` not implemented");
  }
}

/**
 * Field based dimension, abstract class for `field-id`, `fk->`, `datetime-field`, etc
 * @abstract
 */
export class FieldDimension extends Dimension {
  field(): Field {
    if (this._parent instanceof FieldDimension) {
      return this._parent.field();
    }
    return new Field();
  }

  displayName(): string {
    return this.field().displayName();
  }

  subDisplayName(): string {
    if (this._subDisplayName) {
      return this._subTriggerDisplayName;
    } else if (this._parent) {
      // TODO Atte Keinänen 8/1/17: Is this used at all?
      // foreign key, show the field name
      return this.field().display_name;
    } else {
      // TODO Atte Keinänen 8/1/17: Is this used at all?
      return "Default";
    }
  }

  subTriggerDisplayName(): string {
    if (this.defaultDimension() instanceof BinnedDimension) {
      return "Unbinned";
    } else {
      return "";
    }
  }

  icon() {
    return this.field().icon();
  }
}

/**
 * Field ID-based dimension, `["field-id", field-id]`
 */
export class FieldIDDimension extends FieldDimension {
  static parseMBQL(
    mbql: ConcreteField,
    metadata?: ?Metadata,
    query?: ?StructuredQuery,
  ) {
    if (typeof mbql === "number") {
      // DEPRECATED: bare field id
      return new FieldIDDimension(null, [mbql], metadata, query);
    } else if (Array.isArray(mbql) && mbql[0] === "field-id") {
      return new FieldIDDimension(null, mbql.slice(1), metadata, query);
    }
    return null;
  }

  mbql(): LocalFieldReference {
    return ["field-id", this._args[0]];
  }

  field() {
    return (
      (this._metadata && this._metadata.fields[this._args[0]]) ||
      new Field({ id: this._args[0] })
    );
  }
}

/**
 * Field Literal-based dimension, `["field-literal", field-name, base-type]`
 */
export class FieldLiteralDimension extends FieldDimension {
  static parseMBQL(
    mbql: ConcreteField,
    metadata?: ?Metadata,
    query?: ?StructuredQuery,
  ) {
    if (Array.isArray(mbql) && mbql[0] === "field-literal") {
      return new FieldLiteralDimension(null, mbql.slice(1), metadata, query);
    }
    return null;
  }

  mbql(): LocalFieldReference {
    return ["field-literal", ...this._args];
  }

  columnDimension() {
    if (this._query) {
      const query = this._query.sourceQuery();
      const columnNames = query.columnNames();
      const index = _.findIndex(columnNames, name => this._args[0] === name);
      if (index >= 0) {
        return query.columnDimensions()[index];
      }
    }
  }

  name() {
    return this._args[0];
  }

  displayName() {
    return this.field().displayName();
  }

  field() {
    if (this._query) {
      // TODO: more efficient lookup
      const field = _.findWhere(this._query.table().fields, {
        name: this.name(),
      });
      if (field) {
        return field;
      }
    }
    return new Field({
      id: this.mbql(),
      name: this.name(),
      // NOTE: this display_name will likely be incorrect
      // if a `FieldLiteralDimension` isn't associated with a query then we don't know which table it belongs to
      display_name: this.name(),
      base_type: this._args[1],
      // HACK: need to thread the query through to this fake Field
      query: this._query,
      operators: [{ name: "=", verboseName: t`Is`, fields: [] }],
      operators_lookup: {
        "=": { name: "=", verboseName: t`Is`, fields: [] },
      },
    });
  }
}

/**
 * Foreign key-based dimension, `["fk->", fk-field-id, dest-field-id]`
 */
export class FKDimension extends FieldDimension {
  static parseMBQL(
    mbql: ConcreteField,
    metadata?: ?Metadata,
    query?: ?StructuredQuery,
  ): ?Dimension {
    if (Array.isArray(mbql) && mbql[0] === "fk->") {
      // $FlowFixMe
      const fkRef: ForeignFieldReference = mbql;
      const parent = Dimension.parseMBQL(fkRef[1], metadata, query);
      return new FKDimension(parent, fkRef.slice(2), metadata, query);
    }
    return null;
  }

  static dimensions(parent: Dimension): Dimension[] {
    if (parent instanceof FieldDimension) {
      const field = parent.field();
      if (field.target && field.target.table) {
        return field.target.table.fields.map(
          field =>
            new FKDimension(
              parent,
              [field.id],
              parent._metadata,
              parent._query,
            ),
        );
      }
    }
    return [];
  }

  constructor(
    parent: ?Dimension,
    args: any[],
    metadata?: Metadata,
    query?: ?StructuredQuery,
  ): Dimension {
    super(parent, args, metadata, query);
    this._dest = Dimension.parseMBQL(args[0], metadata, query);
  }

  mbql(): ForeignFieldReference {
    return ["fk->", this._parent.mbql(), this._dest.mbql()];
  }

  field() {
    return this._dest.field();
  }

  fk() {
    return this._parent;
  }

  destination() {
    return this._dest;
  }

  column() {
    return {
      ...super.column(),
      fk_field_id: this.fk().field().id,
    };
  }

  render() {
    return [
      stripId(this._parent.field().display_name),
      <Icon name="connections" className="px1" size={10} />,
      this.field().display_name,
    ];
  }
}

import { DATETIME_UNITS, formatBucketing } from "metabase/lib/query_time";

const isFieldDimension = dimension =>
  dimension instanceof FieldIDDimension || dimension instanceof FKDimension;

/**
 * DatetimeField dimension, `["datetime-field", field-reference, datetime-unit]`
 */
export class DatetimeFieldDimension extends FieldDimension {
  static parseMBQL(
    mbql: ConcreteField,
    metadata?: ?Metadata,
    query?: ?StructuredQuery,
  ): ?Dimension {
    if (Array.isArray(mbql) && mbql[0] === "datetime-field") {
      const parent = Dimension.parseMBQL(mbql[1], metadata, query);
      // DEPRECATED: ["datetime-field", id, "of", unit]
      if (mbql.length === 4) {
        return new DatetimeFieldDimension(
          parent,
          mbql.slice(3),
          metadata,
          query,
        );
      } else {
        return new DatetimeFieldDimension(
          parent,
          mbql.slice(2),
          metadata,
          query,
        );
      }
    }
    return null;
  }

  static dimensions(parent: Dimension): Dimension[] {
    if (isFieldDimension(parent) && parent.field().isDate()) {
      return DATETIME_UNITS.map(
        unit =>
          new DatetimeFieldDimension(
            parent,
            [unit],
            this._metadata,
            this._query,
          ),
      );
    }
    return [];
  }

  static defaultDimension(parent: Dimension): ?Dimension {
    if (isFieldDimension(parent) && parent.field().isDate()) {
      return new DatetimeFieldDimension(
        parent,
        [parent.field().getDefaultDateTimeUnit()],
        this._metadata,
        this._query,
      );
    }
    return null;
  }

  mbql(): DatetimeField {
    return ["datetime-field", this._parent.mbql(), this._args[0]];
  }

  baseDimension(): Dimension {
    return this._parent.baseDimension();
  }

  bucketing(): DatetimeUnit {
    return this._args[0];
  }

  subDisplayName(): string {
    return formatBucketing(this._args[0]);
  }

  subTriggerDisplayName(): string {
    return t`by ${formatBucketing(this._args[0]).toLowerCase()}`;
  }

  render() {
    return [...super.render(), ": ", this.subDisplayName()];
  }
}

/**
 * Binned dimension, `["binning-strategy", field-reference, strategy, ...args]`
 */
export class BinnedDimension extends FieldDimension {
  static parseMBQL(
    mbql: ConcreteField,
    metadata?: ?Metadata,
    query?: ?StructuredQuery,
  ) {
    if (Array.isArray(mbql) && mbql[0] === "binning-strategy") {
      const parent = Dimension.parseMBQL(mbql[1], metadata, query);
      return new BinnedDimension(parent, mbql.slice(2));
    }
    return null;
  }

  static dimensions(parent: Dimension): Dimension[] {
    // Subdimensions are are provided by the backend through the dimension_options field property
    return [];
  }

  mbql() {
    return ["binning-strategy", this._parent.mbql(), ...this._args];
  }

  baseDimension(): Dimension {
    return this._parent.baseDimension();
  }

  subTriggerDisplayName(): string {
    if (this._args[0] === "num-bins") {
      const n = this._args[1];
      return ngettext(msgid`${n} bin`, `${n} bins`, n);
    } else if (this._args[0] === "bin-width") {
      const binWidth = this._args[1];
      const units = this.field().isCoordinate() ? "°" : "";
      return `${binWidth}${units}`;
    } else {
      return t`Auto binned`;
    }
  }

  render() {
    return [...super.render(), ": ", this.subTriggerDisplayName()];
  }
}

/**
 * Expression reference, `["expression", expression-name]`
 */
export class ExpressionDimension extends Dimension {
  tag = "Custom";

  static parseMBQL(mbql: any, metadata?: ?Metadata): ?Dimension {
    if (Array.isArray(mbql) && mbql[0] === "expression") {
      return new ExpressionDimension(null, mbql.slice(1));
    }
  }

  mbql(): ExpressionReference {
    return ["expression", this._args[0]];
  }

  displayName(): string {
    return this._args[0];
  }

  columnName() {
    return this._args[0];
  }

  icon(): IconName {
    // TODO: eventually will need to get the type from the return type of the expression
    return "int";
  }
}

const INTEGER_AGGREGATIONS = new Set("count", "cum-count", "distinct");

/**
 * Aggregation reference, `["aggregation", aggregation-index]`
 */
export class AggregationDimension extends Dimension {
  static parseMBQL(
    mbql: any,
    metadata?: ?Metadata,
    query?: ?StructuredQuery,
  ): ?Dimension {
    if (Array.isArray(mbql) && mbql[0] === "aggregation") {
      return new AggregationDimension(null, mbql.slice(1), metadata, query);
    }
  }

  aggregationIndex(): number {
    return this._args[0];
  }

  displayName(): string {
    const name = this.columnName();
    return name
      ? getFriendlyName({ name: name, display_name: name })
      : `[${t`Unknown`}]`;
  }

  fieldDimension() {
    const aggregation = this.aggregation();
    if (aggregation.length === 2 && aggregation[1]) {
      return Dimension.parseMBQL(aggregation[1], this._metadata, this._query);
    }
    return null;
  }

  column() {
    const [short] = this.aggregation() || [];
    return {
      ...super.column(),
      base_type: INTEGER_AGGREGATIONS.has(short)
        ? "type/Integer"
        : "type/Float",
      display_name: short,
      name: short,
      source: "aggregation",
    };
  }

  field() {
    // FIXME: it isn't really correct to return the unaggregated field. return a fake Field object?
    const dimension = this.fieldDimension();
    return dimension ? dimension.field() : super.field();
  }

  // MBQL of the underlying aggregation
  aggregation() {
    const aggregation =
      this._query && this._query.aggregations()[this.aggregationIndex()];
    if (aggregation) {
      return aggregation[0] === "named" ? aggregation[1] : aggregation;
    }
    return null;
  }

  columnName() {
    const aggregation =
      this._query && this._query.aggregations()[this.aggregationIndex()];
    if (aggregation) {
      // FIXME: query lib
      if (aggregation[0] === "named") {
        return aggregation[2];
      } else {
        const short = aggregation[0];
        // NOTE: special case for "distinct"
        return short === "distinct" ? "count" : short;
      }
    }
    return null;
  }

  mbql() {
    return ["aggregation", this._args[0]];
  }

  icon() {
    return "int";
  }
}

/**
 * Joined field reference, `["joined-field", alias, ConcreteField]`
 */
export class JoinedDimension extends FieldDimension {
  static parseMBQL(
    mbql: ConcreteField,
    metadata?: ?Metadata,
    query?: ?StructuredQuery,
  ): ?Dimension {
    if (Array.isArray(mbql) && mbql[0] === "joined-field") {
      const parent = Dimension.parseMBQL(mbql[2], metadata, query);
      return new JoinedDimension(parent, [mbql[1]], metadata, query);
    }
    return null;
  }

  mbql(): ForeignFieldReference {
    return ["joined-field", this._args[0], this._parent.mbql()];
  }
}

const DIMENSION_TYPES: typeof Dimension[] = [
  FieldIDDimension,
  FieldLiteralDimension,
  FKDimension,
  DatetimeFieldDimension,
  ExpressionDimension,
  BinnedDimension,
  AggregationDimension,
  JoinedDimension,
];
